module.exports = Client

var auto = require('run-auto')
var extend = require('extend.js')
var DHT = require('bittorrent-dht')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var magnet = require('magnet-uri')
var parseTorrent = require('parse-torrent')
var portfinder = require('portfinder')
var speedometer = require('speedometer')
var Torrent = require('./lib/torrent')
var Storage = require('./lib/storage')

portfinder.basePort = Math.floor(Math.random() * 64000) + 1025 // pick port >1024

inherits(Client, EventEmitter)

/**
 * Create a new `bittorrent-client` instance. Available options described in the README.
 * @param {Object} opts
 */
function Client (opts) {
  var self = this
  if (!(self instanceof Client)) {
    return new Client(opts)
  }
  EventEmitter.call(self)

  opts = extend({
    dht: true,
    maxDHT: 1000,
    trackers: true
  }, opts)

  // TODO: should these ids be consistent between restarts?
  self.peerId = opts.peerId || new Buffer('-WW0001-' + hat(48), 'utf8')
  self.nodeId = opts.nodeId || new Buffer(hat(160), 'hex')

  self.dhtPort = opts.dhtPort
  self.torrentPort = opts.torrentPort
  self.trackersEnabled = ('trackers' in opts ? opts.trackers : true)

  self.maxDHT = opts.maxDHT // maximum number of peers to find through DHT

  self.ready = false
  self.torrents = []
  this.downloadSpeed = speedometer()
  this.uploadSpeed = speedometer()

  self.log = opts.quiet ? function () {} : console.log

  var tasks = {
    torrentPort: function (cb) {
      if (self.torrentPort) {
        cb(null, self.torrentPort)
      } else {
        portfinder.getPort(cb)
      }
    }
  }

  if (opts.dht && opts.maxDHT > 0) {
    self.dht = new DHT({ nodeId: self.nodeId })

    self.dht.on('peer', function (addr, infoHash) {
      var torrent = self.get(infoHash)
      torrent.addPeer(addr)
    })

    tasks.dhtPort = function (cb) {
      // TODO: DHT port should be consistent between restarts
      if (self.dhtPort) {
        cb(null, self.dhtPort)
      } else {
        portfinder.getPort(cb)
      }
    }
  }

  var ready = function () {
    self.ready = true
    self.emit('ready')
  }

  auto(tasks, function (err, r) {
    self.dhtPort = r.dhtPort
    self.torrentPort = r.torrentPort

    if (self.dht) {
      self.dht.listen(self.dhtPort, ready)
    } else {
      ready()
    }
  })
}

Client.Storage = Storage

/**
 * Aggregate seed ratio for all torrents in the client.
 * @type {number}
 */
Object.defineProperty(Client.prototype, 'ratio', {
  get: function () {
    var self = this

    var uploaded = self.torrents.reduce(function (total, torrent) {
      return total + torrent.uploaded
    }, 0)
    var downloaded = self.torrents.reduce(function (total, torrent) {
      return total + torrent.downloaded
    }, 0)

    if (downloaded === 0) return 0
    return uploaded / downloaded
  }
})

/**
 * Return the torrent with the given `torrentId`. Easier than searching through the
 * `client.torrents` array by hand for the torrent you want.
 * @param  {string|Buffer} torrentId
 * @return {Torrent}
 */
Client.prototype.get = function (torrentId) {
  var self = this
  var infoHash = Client.toInfoHash(torrentId)
  for (var i = 0, len = self.torrents.length; i < len; i++) {
    var torrent = self.torrents[i]
    if (torrent.infoHash === infoHash) {
      return torrent
    }
  }
  return null
}

/**
 * Add a new torrent to the client. `torrentId` can be any type accepted by the
 * constructor: magnet uri (utf8 string), torrent file (buffer), or info hash (hex
 * string or buffer).
 *
 * @param {string|Buffer} torrentId magnet uri, torrent file, or infohash
 * @param {Object}        opts      optional torrent-specific options
 * @param {function=}     cb        called with the torrent that was created (might not have metadata yet)
 */
Client.prototype.add = function (torrentId, opts, cb) {
  var self = this
  if (!self.ready) {
    return self.once('ready', self.add.bind(self, torrentId, opts, cb))
  }
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (typeof cb !== 'function') cb = function () {}

  var torrent = new Torrent(torrentId, extend({
    peerId: self.peerId,
    torrentPort: self.torrentPort,
    dhtPort: self.dhtPort,
    trackers: self.trackersEnabled,
    dht: !!self.dht,
    log: self.log
  }, opts))
  self.torrents.push(torrent)

  torrent.swarm.on('download', function (downloaded) {
    self.downloadSpeed(downloaded)
  })
  torrent.swarm.on('upload', function (uploaded) {
    self.uploadSpeed(uploaded)
  })

  self.emit('addTorrent', torrent)

  torrent.on('listening', function (port) {
    self.log('Swarm listening on port ' + port)
    self.emit('listening', torrent)
    // TODO: Add the torrent to the public DHT so peers know to find us
  })

  torrent.on('error', function (err) {
    self.emit('error', err)
  })

  torrent.on('metadata', function () {
    // emit 'torrent' when a torrent is ready to be used
    self.emit('torrent', torrent)
  })

  if (self.dht) {
    // TODO: fix dht to support calling this multiple times
    self.dht.setInfoHash(torrent.infoHash)
    self.dht.findPeers(self.maxDHT)
  }

  // users can listen for 'torrent' event if they want to wait until a torrent
  // is ready to be used. the callback will happen as soon as the client is
  // ready and we've created it.
  cb(null, torrent)

  return self
}

/**
 * Remove a torrent from the client. Destroy all connections to peers and delete all
 * saved file data. Optional callback is called when file data has been removed.
 * @param  {string|Buffer}   torrentId
 * @param  {function} cb
 */
Client.prototype.remove = function (torrentId, cb) {
  var self = this
  var torrent = self.get(torrentId)
  if (!torrent) {
    throw new Error('No torrent with id ' + torrentId)
  }
  self.torrents.splice(self.torrents.indexOf(torrent), 1)
  torrent.destroy(cb)

  return self
}

/**
 * Destroy the client, including all torrents and connections to peers.
 * @param  {function} cb
 */
Client.prototype.destroy = function (cb) {
  var self = this

  if (self.dht)
    self.dht.close()

  var torrents = self.torrents.slice(0) // clone before iteration
  torrents.forEach(function (torrent) {
    // TODO: chain cb here
    self.remove(torrent.infoHash)
  })

  return self
}

//
// HELPER METHODS
//

/**
 * Given a magnet uri, torrent file, or info hash, return a hex string info hash
 * @param  {string|Buffer} torrentId magnet uri, torrent file, or infohash
 * @return {string} info hash (hex string)
 */
Client.toInfoHash = function (torrentId) {
  if (typeof torrentId === 'string') {
    if (!/^magnet:/.test(torrentId) && torrentId.length === 40 || torrentId.length === 32) {
      // info hash (hex/base-32 string)
      torrentId = 'magnet:?xt=urn:btih:' + torrentId
    }
    // magnet uri
    var info = magnet(torrentId)
    return info && info.infoHash
  } else if (Buffer.isBuffer(torrentId)) {
    if (torrentId.length === 20) {
      // info hash (buffer)
      return torrentId.toString('hex')
    } else {
      // torrent file
      try {
        return parseTorrent(torrentId).infoHash
      } catch (err) {
        return null
      }
    }
  }
}
