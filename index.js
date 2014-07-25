module.exports = Client

var debug = require('debug')('bittorrent-client')
var DHT = require('bittorrent-dht/client')
var EventEmitter = require('events').EventEmitter
var extend = require('extend.js')
var hat = require('hat')
var inherits = require('inherits')
var magnet = require('magnet-uri')
var once = require('once')
var parallel = require('run-parallel')
var parseTorrent = require('parse-torrent')
var portfinder = require('portfinder')
var speedometer = require('speedometer')
var Storage = require('./lib/storage')
var Torrent = require('./lib/torrent')

portfinder.basePort = Math.floor(Math.random() * 64000) + 1025 // pick port >1024

inherits(Client, EventEmitter)

/**
 * Create a new `bittorrent-client` instance. Available options described in the README.
 * @param {Object} opts
 */
function Client (opts) {
  var self = this
  if (!(self instanceof Client)) return new Client(opts)
  EventEmitter.call(self)

  // default options
  opts = extend({
    dht: true,
    trackers: true
  }, opts)

  // TODO: these ids should be consistent between restarts!
  self.peerId = opts.peerId || new Buffer('-WW0001-' + hat(48), 'utf8')
  self.nodeId = opts.nodeId || new Buffer(hat(160), 'hex')

  self.dhtPort = opts.dhtPort
  self.torrentPort = opts.torrentPort

  self.trackersEnabled = opts.trackers

  self.ready = false
  self.torrents = []
  self.blocklist = opts.blocklist || []
  self.downloadSpeed = speedometer()
  self.uploadSpeed = speedometer()

  var tasks = []

  if (!self.torrentPort) {
    tasks.push(function (cb) {
      portfinder.getPort(function (err, port) {
        self.torrentPort = port
        cb(err)
      })
    })
  }

  if (opts.dht) {
    var dhtOpts = extend({ nodeId: self.nodeId }, opts.dht)
    // TODO: listen for 'ready event'
    self.dht = new DHT(dhtOpts)

    self.dht.on('peer', function (addr, infoHash) {
      var torrent = self.get(infoHash)
      torrent.addPeer(addr)
    })

    if (!self.dhtPort) {
      // TODO: DHT port should be consistent between restarts
      tasks.push(function (cb) {
        portfinder.getPort(function (err, port) {
          self.dhtPort = port
          cb(err)
        })
      })
    }
  }

  parallel(tasks, function (err) {
    if (err) return self.emit('error', err)
    if (self.dht) {
      self.dht.listen(self.dhtPort)
    }
    self.ready = true
    self.emit('ready')
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
 * Add a new torrent to the client. `torrentId` can be a magnet uri (utf8 string),
 * torrent file (buffer), or info hash (hex string or buffer).
 *
 * @param {string|Buffer|Object} torrentId magnet uri, torrent file, info hash, or parsed torrent
 * @param {Object} opts optional torrent-specific options
 * @param {function=} cb called when the torrent is ready and has metadata
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
  cb = once(cb)

  var torrent = new Torrent(torrentId, extend({
    blocklist: self.blocklist,
    dht: !!self.dht,
    dhtPort: self.dhtPort,
    peerId: self.peerId,
    torrentPort: self.torrentPort,
    trackers: self.trackersEnabled
  }, opts))
  self.torrents.push(torrent)

  torrent.swarm.on('download', function (downloaded) {
    self.downloadSpeed(downloaded)
  })
  torrent.swarm.on('upload', function (uploaded) {
    self.uploadSpeed(uploaded)
  })

  process.nextTick(function () {
    self.emit('addTorrent', torrent)
  })

  torrent.on('listening', function (port) {
    debug('Swarm listening on port ' + port)
    self.emit('listening', torrent)
    // TODO: Add the torrent to the public DHT so peers know to find us
  })

  torrent.on('error', function (err) {
    cb(err)
    self.emit('error', err)
  })

  torrent.on('metadata', function () {
    // Call callback and emit 'torrent' when a torrent is ready to be used
    cb(null, torrent)
    self.emit('torrent', torrent)
  })

  if (self.dht) {
    self.dht.lookup(torrent.infoHash)
  }

  return torrent
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
}

/**
 * Destroy the client, including all torrents and connections to peers.
 * @param  {function} cb
 */
Client.prototype.destroy = function (cb) {
  var self = this

  if (self.dht) {
    self.dht.destroy()
  }

  var tasks = self.torrents.map(function (torrent) {
    return function (cb) {
      self.remove(torrent.infoHash, cb)
    }
  })

  parallel(tasks, cb)
}

//
// HELPER METHODS
//

/**
 * Given a magnet uri, torrent file, info hash, or parsed torrent, return a hex string info hash
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
  } else if (torrentId && torrentId.infoHash) {
    // parsed torrent (from parse-torrent module)
    return torrentId.infoHash
  } else {
    return null
  }
}
