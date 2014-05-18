module.exports = Torrent

var _ = require('underscore')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var ip = require('ip')
var magnet = require('magnet-uri')
var parallel = require('run-parallel')
var parseTorrent = require('parse-torrent')
var Storage = require('./storage')
var Swarm = require('bittorrent-swarm')
var TrackerClient = require('bittorrent-tracker').Client
var ut_metadata = require('ut_metadata')

var MAX_BLOCK_LENGTH = 128 * 1024
var MAX_OUTSTANDING_REQUESTS = 5
var PIECE_TIMEOUT = 10000
var CHOKE_TIMEOUT = 5000
var SPEED_THRESHOLD = 3 * Storage.BLOCK_LENGTH
function noop () {}

inherits(Torrent, EventEmitter)

/**
 * A torrent
 *
 * @param {string|Buffer} torrentId   magnet uri, torrent file, or info hash
 * @param {Object} opts   options object
 */
function Torrent (torrentId, opts) {
  var self = this
  EventEmitter.call(self)

  self.peerId = opts.peerId
  self.torrentPort = opts.torrentPort
  self.dhtPort = opts.dhtPort
  self.trackersEnabled = ('trackers' in opts ? opts.trackers : true)
  self.hotswapEnabled = ('hotswap' in opts ? opts.hotswap : true)

  self.chokeTimeout = opts.chokeTimeout || CHOKE_TIMEOUT
  self.pieceTimeout = opts.pieceTimeout || PIECE_TIMEOUT

  self.files = []
  self.metadata = null
  self.parsedTorrent = null
  self.storage = null
  self.blocklist = opts.blocklist || []
  self._announce = []
  self._amInterested = false
  self._destroyed = false
  self._selections = []
  self._critical = []
  self._storageImpl = opts.storage || Storage
  self._remove = !!opts.remove

  self.log = opts.log || console.log

  if (typeof torrentId === 'string') {
    if (!/^magnet:/.test(torrentId) && torrentId.length === 40 || torrentId.length === 32) {
      // info hash (hex/base-32 string)
      torrentId = 'magnet:?xt=urn:btih:' + torrentId
    }

    // magnet uri
    var info = magnet(torrentId)
    if (!info.infoHash) {
      return self.emit('error', new Error('invalid torrent uri'))
    }

    if (info.announce) {
      self._announce = info.announce
    }

    self.infoHash = info.infoHash
    self.name = info.name
  } else if (Buffer.isBuffer(torrentId)) {
    if (torrentId.length === 20) {
      // info hash (buffer)
      self.infoHash = torrentId.toString('hex')
    } else {
      // torrent file
      self._onMetadata(torrentId)
    }
  } else {
    self.emit('error', new Error('invalid torrentId ' + torrentId))
  }

  var handshake = {}
  if (opts.dht && self.dhtPort) {
    handshake.dht = true
  }

  self.swarm = new Swarm(self.infoHash, self.peerId, {
    handshake: handshake,
    log: self.log
  })

  if (self.torrentPort) {
    self.swarm.listen(self.torrentPort, function (port) {
      self.emit('listening', port)
    })
  }

  self.swarm.on('error', function (err) {
    self.emit('error', err)
  })

  self.swarm.on('wire', self._onWire.bind(self))
}

/**
 * Torrent size (in bytes)
 */
Object.defineProperty(Torrent.prototype, 'length', {
  get: function () {
    var self = this
    if (!self.parsedTorrent) {
      return 0
    }
    return self.parsedTorrent.length
  }
})

/**
 * Time remaining (in milliseconds)
 */
Object.defineProperty(Torrent.prototype, 'timeRemaining', {
  get: function () {
    var self = this
    var remainingBytes = self.length - self.downloaded
    if (self.swarm.downloadSpeed() === 0) {
      return Infinity
    }
    return (remainingBytes / self.swarm.downloadSpeed()) * 1000
  }
})

/**
 * Percentage complete, represented as a number between 0 and 1
 */
Object.defineProperty(Torrent.prototype, 'progress', {
  get: function () {
    var self = this
    if (!self.parsedTorrent) {
      return 0
    }
    return self.downloaded / self.parsedTorrent.length
  }
})

/**
 * Bytes downloaded (not necessarily verified)
 */
Object.defineProperty(Torrent.prototype, 'downloaded', {
  get: function () {
    var self = this
    return (self.storage && self.storage.downloaded) || 0
  }
})

/**
 * Bytes uploaded
 */
Object.defineProperty(Torrent.prototype, 'uploaded', {
  get: function () {
    var self = this
    return self.swarm.uploaded
  }
})

/**
 * Ratio of bytes downloaded to uploaded
 */
Object.defineProperty(Torrent.prototype, 'ratio', {
  get: function () {
    var self = this
    if (self.uploaded === 0) {
      return 0
    }
    return self.downloaded / self.uploaded
  }
})

/**
 * Destroy and cleanup this torrent.
 */
Torrent.prototype.destroy = function (cb) {
  var self = this
  self._destroyed = true
  cb = cb || noop

  if (self.tracker)
    self.tracker.stop()

  var tasks = []

  if (self.swarm) {
    tasks.push(function (cb) {
      self.swarm.destroy(cb)
    })
  }

  if (self.storage) {
    tasks.push(function (cb) {
      self.storage.close(function (err) {
        if (!err && self._remove) {
          self.storage.remove(cb)
        } else {
          cb(err)
        }
      })
    })
  }

  parallel(tasks, cb)
}

/**
 * Add a peer to the swarm
 * @param {string} addr
 */
Torrent.prototype.addPeer = function (addr) {
  var self = this

  var blockedReason = null
  if (self.blocklist.length && (blockedReason = isPeerBlocked(addr, self.blocklist))) {
    self.emit('blocked-peer', addr, blockedReason)
  } else {
    self.swarm.add(addr)
  }
}

/**
 * Select a range of pieces to prioritize.
 *
 * @param {number}    start     start piece index (inclusive)
 * @param {number}    end       end piece index (inclusive)
 * @param {number}    priority  priority associated with this selection
 * @param {function}  notify    callback when selection is updated with new data
 */
Torrent.prototype.select = function (start, end, priority, notify) {
  var self = this

  if (start > end || start < 0 || end >= self.storage.pieces.length) {
    throw new Error('invalid selection ', start, ':', end)
  }

  self._selections.push({
    from: start,
    to: end,
    offset: 0,
    priority: Number(priority) || 0,
    notify: notify || noop
  })

  self._selections.sort(function (a, b) {
    return b.priority - a.priority
  })

  self._updateSelections()
}

/**
 * Deprioritizes a range of previously selected pieces.
 *
 * @param {number}  start     start piece index (inclusive)
 * @param {number}  end       end piece index (inclusive)
 * @param {number}  priority  priority associated with the selection
 */
Torrent.prototype.deselect = function (start, end, priority) {
  var self = this
  priority = Number(priority) || 0

  for (var i = 0; i < self._selections.length; ++i) {
    var s = self._selections[i]
    if (s.from === start && s.to === end && s.priority === priority) {
      self._selections.splice(i--, 1)
      break
    }
  }

  self._updateSelections()
}

/**
 * Marks a range of pieces as critical priority to be downloaded ASAP.
 *
 * @param {number}  start  start piece index (inclusive)
 * @param {number}  end    end piece index (inclusive)
 */
Torrent.prototype.critical = function (start, end) {
  var self = this

  for (var i = start; i <= end; ++i) {
    self._critical[i] = true
  }

  self._updateSelections()
}

//
// HELPER METHODS
//

Torrent.prototype._onWire = function (wire) {
  var self = this

  wire.use(ut_metadata(self.metadata))

  if (!self.metadata) {
    wire.ut_metadata.on('metadata', function (metadata) {
      self._onMetadata(metadata)
    })
    wire.ut_metadata.fetch()
  }

  // Send KEEP-ALIVE (every 60s) so peers will not disconnect the wire
  wire.setKeepAlive(true)

  // If peer supports DHT, send PORT message to report DHT node listening port
  if (wire.peerExtensions.dht && self.dhtPort) {
    self.log(wire.remoteAddress, 'supports DHT')
    wire.port(self.dhtPort)
  }

  // When peer sends PORT, add them to the routing table
  wire.on('port', function (port) {
    self.log(wire.remoteAddress, 'port', port)
    // TODO: DHT doesn't have a routing table yet
    // dht.add(wire.remoteAddress, port)
  })

  wire.on('timeout', function () {
    self.log('timeout', wire.remoteAddress)
    // TODO: this might be destroying wires too eagerly
    wire.destroy()
  })

  // Timeout for piece requests to this peer
  wire.setTimeout(self.pieceTimeout)

  if (self.metadata) {
    self._onWireWithMetadata(wire)
  }
}

Torrent.prototype._onWireWithMetadata = function (wire) {
  var self = this
  var update = self._update.bind(self)
  var timeoutId = null
  var timeoutMs = self.chokeTimeout

  function onChokeTimeout () {
    if (self._destroyed || wire._destroyed) return

    if (self.swarm.numQueued > 2 * (self.swarm.numConns - self.swarm.numPeers) && wire.amInterested) {
      wire.destroy()
    } else {
      timeoutId = setTimeout(onChokeTimeout, timeoutMs)
    }
  }

  wire.on('bitfield', update)
  wire.on('have', update)

  wire.once('interested', function () {
    wire.unchoke()
  })

  wire.on('close', function () {
    clearTimeout(timeoutId)
  })

  wire.on('choke', function () {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(onChokeTimeout, timeoutMs)
  })

  wire.on('unchoke', function () {
    clearTimeout(timeoutId)
    update()
  })

  wire.on('request', function (index, offset, length, cb) {
    // Disconnect from peers that request more than 128KB, per spec
    if (length > MAX_BLOCK_LENGTH) {
      console.error(wire.remoteAddress, 'requested invalid block size', length)
      return wire.destroy()
    }

    self.storage.readBlock(index, offset, length, cb)
  })

  wire.bitfield(self.storage.bitfield) // always send bitfield (required)
  wire.interested() // always start out interested

  timeoutId = setTimeout(onChokeTimeout, timeoutMs)
  self._updateSelections()
}

Torrent.prototype._onMetadata = function (metadata) {
  var self = this

  if (self.metadata) {
    return
  }

  self.metadata = metadata

  try {
    self.parsedTorrent = parseTorrent(self.metadata)
  } catch (err) {
    return self.emit('error', err)
  }

  self.parsedTorrent.announce = _.union(self.parsedTorrent.announce, self._announce)

  self.name = self.parsedTorrent.name
  self.infoHash = self.parsedTorrent.infoHash

  self.storage = new self._storageImpl(self.parsedTorrent, { log : self.log })
  self.storage.on('piece', self._onStoragePiece.bind(self))
  self.storage.on('file', function (file) {
    self.log('FILE', file.name)

    // TODO: do something smarter
    self.emit('file', file)
  })

  self._reservations = self.storage.pieces.map(function () {
    return []
  })

  self.storage.on('done', function () {
    self.log()
    self.log('DONE DOWNLOADING TORRENT!')
    self.log()

    if (self.tracker)
      self.tracker.complete()

    // TODO: do something smarter
    self.emit('done')
  })

  self.storage.on('select', self.select.bind(self))
  self.storage.on('deselect', self.deselect.bind(self))
  self.storage.on('critical', self.critical.bind(self))

  // start off selecting the entire torrent with low priority
  self.select(0, self.storage.pieces.length - 1, false)

  self.storage.files.forEach(function (file) {
    self.files.push(file)
  })

  if (self.trackersEnabled && self.parsedTorrent.announce.length > 0) {
    self.tracker = new TrackerClient(self.peerId, self.torrentPort, self.parsedTorrent)
    self.tracker.on('error', function (err) {
      // trackers are optional and their errors should not affect the client
      self.emit('warning', err)
    })
    self.tracker.on('peer', function (addr) {
      self.addPeer(addr)
    })

    self.tracker.start()
  }

  if (self.swarm) {
    self.swarm.wires.forEach(function (wire) {
      self._onWireWithMetadata(wire)
    })
  }

  process.nextTick(function () {
    self.emit('metadata')
  })
}

/**
 * When a piece is fully downloaded, notify all peers with a HAVE message.
 * @param {Piece} piece
 */
Torrent.prototype._onStoragePiece = function (piece) {
  var self = this
  self._reservations[piece.index] = null

  self.swarm.wires.forEach(function (wire) {
    wire.have(piece.index)
  })

  self._gcSelections()
}

/**
 * Called on selection changes.
 */
Torrent.prototype._updateSelections = function () {
  var self = this
  if (!self.swarm || self._destroyed) return
  if (!self.metadata) return self.once('metadata', self._updateSelections.bind(self))

  process.nextTick(self._gcSelections.bind(self))
  self._updateInterest()
  self._update()
}

/**
 * Garbage collect selections with respect to the storage's current state.
 */
Torrent.prototype._gcSelections = function () {
  var self = this

  for (var i = 0; i < self._selections.length; i++) {
    var s = self._selections[i]
    var oldOffset = s.offset

    // check for newly downloaded pieces in selection
    while (self.storage.bitfield.get(s.from + s.offset) && s.from + s.offset < s.to) {
      s.offset++
    }

    if (oldOffset !== s.offset) s.notify()
    if (s.to !== s.from + s.offset) continue
    if (!self.storage.bitfield.get(s.from + s.offset)) continue

    // remove fully downloaded selection
    self._selections.splice(i--, 1) // decrement i to offset splice
    s.notify() // TODO: this may notify twice in a row. is this a problem?
    self._updateInterest()
  }

  if (!self._selections.length) self.emit('idle')
}

/**
 * Update interested status for all peers.
 */
Torrent.prototype._updateInterest = function () {
  var self = this

  var prev = self._amInterested
  self._amInterested = !!self._selections.length

  self.swarm.wires.forEach(function (wire) {
    // TODO: only call wire.interested if the wire has at least one piece we need
    // TODO: only call wire.interested/uninterested if our interest has changed
    if (self._amInterested) wire.interested()
    else wire.uninterested()
  })

  if (prev === self._amInterested) return
  if (self._amInterested) self.emit('interested')
  else self.emit('uninterested')
}

/**
 * Heartbeat to update all peers and their requests.
 */
Torrent.prototype._update = function () {
  var self = this
  if (self._destroyed) return

  // update wires in random order for better request distribution
  // TODO: verify that randomization actually helps here
  randomizedForEach(self.swarm.wires, self._updateWire.bind(self))
}

/**
 * Attempts to update a peer's requests
 */
Torrent.prototype._updateWire = function (wire) {
  var self = this

  if (wire.peerChoking) return
  if (!wire.downloaded) return validateWire()

  trySelectWire(false) || trySelectWire(true)

  // TODO: Do we need validateWire and trySelectWire?
  function validateWire () {
    if (wire.requests.length) return

    for (var i = self._selections.length; i--;) {
      var next = self._selections[i]

      for (var j = next.to; j >= next.from + next.offset; j--) {
        if (!wire.peerPieces.get(j)) continue
        if (self._request(wire, j, false)) return
      }
    }

    // TODO: wire failed to validate as useful; should we close it?
  }

  function speedRanker () {
    var speed = wire.downloadSpeed() || 1
    if (speed > SPEED_THRESHOLD) return function () { return true }

    var secs = MAX_OUTSTANDING_REQUESTS * Storage.BLOCK_LENGTH / speed
    var tries = 10
    var ptr = 0

    return function (index) {
      if (!tries || self.storage.bitfield.get(index)) return true

      var piece = self.storage.pieces[index]
      var missing = piece.blocks.length - piece.blocksWritten

      for (; ptr < self.swarm.wires.length; ptr++) {
        var otherWire = self.swarm.wires[ptr]
        var otherSpeed = otherWire.downloadSpeed()

        if (otherSpeed < SPEED_THRESHOLD) continue
        if (otherSpeed <= speed) continue
        if (!otherWire.peerPieces.get(index)) continue
        if ((missing -= otherSpeed * secs) > 0) continue

        tries--
        return false
      }

      return true
    }
  }

  function shufflePriority (i) {
    var last = i
    for (var j = i; j < self._selections.length && self._selections[j].priority; j++) {
      last = j
    }
    var tmp = self._selections[i]
    self._selections[i] = self._selections[last]
    self._selections[last] = tmp
  }

  function trySelectWire (hotswap) {
    if (wire.requests.length >= MAX_OUTSTANDING_REQUESTS) return true
    var rank = speedRanker()

    for (var i = 0; i < self._selections.length; i++) {
      var next = self._selections[i]

      for (var j = next.from + next.offset; j <= next.to; j++) {
        if (!wire.peerPieces.get(j) || !rank(j)) continue

        while (wire.requests.length < MAX_OUTSTANDING_REQUESTS &&
               self._request(wire, j, self._critical[j] || hotswap)) {}

        if (wire.requests.length < MAX_OUTSTANDING_REQUESTS) continue
        if (next.priority) shufflePriority(i)

        return true
      }
    }

    return false
  }
}

/**
 * Attempts to cancel a slow block request from another wire such that the
 * given wire may effectively swap out the request for one of its own.
 */
Torrent.prototype._hotswap = function (wire, index) {
  var self = this
  if (!self.hotswapEnabled) return false

  var speed = wire.downloadSpeed()
  if (speed < Storage.BLOCK_LENGTH) return false
  if (!self._reservations[index]) return false

  var r = self._reservations[index]
  if (!r) {
    return false
  }

  var minSpeed = Infinity
  var minWire

  for (var i = 0; i < r.length; i++) {
    var otherWire = r[i]
    if (!otherWire || otherWire === wire) continue

    var otherSpeed = otherWire.downloadSpeed()
    if (otherSpeed >= SPEED_THRESHOLD) continue
    if (2 * otherSpeed > speed || otherSpeed > minSpeed) continue

    minWire = otherWire
    minSpeed = otherSpeed
  }

  if (!minWire) return false

  for (var i = 0; i < r.length; i++) {
    if (r[i] === minWire) r[i] = null
  }

  for (var i = 0; i < minWire.requests.length; i++) {
    var req = minWire.requests[i]
    if (req.piece !== index) continue

    self.storage.cancelBlock(index, req.offset)
  }

  self.emit('hotswap', minWire, wire, index)
  return true
}

/**
 * Attempts to request a block from the given wire.
 */
Torrent.prototype._request = function (wire, index, hotswap) {
  var self = this
  var numRequests = wire.requests.length

  if (self.storage.bitfield.get(index)) return false
  if (numRequests >= MAX_OUTSTANDING_REQUESTS) return false

  var endGame = (wire.requests.length === 0 && self.storage.numMissing < 30)
  var block = self.storage.reserveBlock(index, endGame)

  if (!block && !endGame && hotswap && self._hotswap(wire, index))
    block = self.storage.reserveBlock(index, false)
  if (!block) return false

  var r = self._reservations[index]
  if (!r) {
    r = self._reservations[index] = []
  }
  var i = r.indexOf(null)
  if (i === -1) i = r.length
  r[i] = wire

  wire.request(index, block.offset, block.length, function (err, buffer) {
    if (r[i] === wire) r[i] = null

    if (err) {
      self.log(wire.remoteAddress, 'requestPiece', index, 'offset', block.offset, 'length', block.length, 'ERROR', err)
      self.storage.cancelBlock(index, block.offset)
      process.nextTick(self._update.bind(self))
      return false
    } else {
      self.log(wire.remoteAddress, 'requestPiece', index, 'offset', block.offset, 'length', block.length, 'DONE')
      self.storage.writeBlock(index, block.offset, buffer, function (err) {
        if (err) {
          self.log(wire.remoteAddress, 'requestPiece', index, 'offset', block.offset, 'length', block.length, 'ERROR writing block', err)
          self.storage.cancelBlock(index, block.offset)
        }

        process.nextTick(self._update.bind(self))
      })
    }
  })

  return true
}

/**
 * Returns a random integer in [0,high)
 */
function randomInt (high) {
  return Math.random() * high | 0
}

/**
 * Iterates through the given array in a random order, calling the given
 * callback for each element.
 */
function randomizedForEach (array, cb) {
  var indices = array.map(function (value, index) { return index })

  for (var i = 0, len = indices.length; i < len; ++i) {
    var j = randomInt(len)
    var tmp = indices[i]
    indices[i] = indices[j]
    indices[j] = tmp
  }

  indices.forEach(function (index) {
    cb(array[index], index, array)
  })
}

function isPeerBlocked (addr, blocklist) {
  var blockedReason = null
  // TODO: support IPv6
  var searchAddr = ip.toLong(addr)
  for (var i = 0, l = blocklist.length; i < l; i++) {
    var block = blocklist[i]
    if (!block.startAddress || !block.endAddress) continue
    var startAddress = ip.toLong(block.startAddress)
    var endAddress = ip.toLong(block.endAddress)
    if (searchAddr >= startAddress && searchAddr <= endAddress) {
      blockedReason = block.reason || true
      break
    }
  }
  return blockedReason
}
