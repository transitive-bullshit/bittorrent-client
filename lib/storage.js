module.exports = Storage

var BitField = require('bitfield')
var FileStream = require('./file_stream')
var EventEmitter = require('events').EventEmitter
var Rusha = require('rusha-browserify') // Fast SHA1 (works in browser)
var extend = require('extend.js')
var inherits = require('inherits')
var stream = require('stream')
var eos = require('end-of-stream')

var BLOCK_LENGTH = 16 * 1024

var BLOCK_BLANK = 0
var BLOCK_RESERVED = 1
var BLOCK_WRITTEN = 2
var noop = function () {}

inherits(Piece, EventEmitter)

/**
 * A torrent piece
 *
 * @param {number} index  piece index
 * @param {string} hash   sha1 hash (hex) for this piece
 * @param {Buffer|number} buffer backing buffer for this piece or length of piece if the backing buffer is lazy
 */
function Piece (index, hash, buffer) {
  var self = this
  EventEmitter.call(self)

  self.index = index
  self.hash = hash

  if (typeof buffer === 'number') {
    // alloc buffer lazily
    self.buffer = null
    self.length = buffer
  } else {
    // use buffer provided
    self.buffer = buffer
    self.length = buffer.length
  }

  self._reset()
}

Piece.prototype.readBlock = function (offset, length, cb) {
  var self = this
  if (!self._verifyOffset(offset)) {
    return cb(new Error("invalid block offset " + offset))
  }

  process.nextTick(function () {
    cb(null, self.buffer.slice(offset, offset + length))
  })
}

Piece.prototype.writeBlock = function (offset, buffer, cb) {
  var self = this
  if (!self._verifyOffset(offset) || !self._verifyBlock(offset, buffer)) {
    return cb(new Error("invalid block " + offset + ":" + buffer.length))
  }

  var i = offset / BLOCK_LENGTH
  if (self.blocks[i] === BLOCK_WRITTEN) {
    return cb(null)
  }

  buffer.copy(self.buffer, offset)
  self.blocks[i] = BLOCK_WRITTEN
  self.blocksWritten += 1

  if (self.blocksWritten === self.blocks.length) {
    self._verify()
  }

  process.nextTick(function () {
    cb(null)
  })
}

Piece.prototype.reserveBlock = function (endGame) {
  var self = this
  var len = self.blocks.length
  for (var i = 0; i < len; i++) {
    if ((self.blocks[i] && !endGame) || self.blocks[i] === BLOCK_WRITTEN) {
      continue
    }
    self.blocks[i] = BLOCK_RESERVED
    return {
      offset: i * BLOCK_LENGTH,
      length: (i === len - 1)
        ? self.length - (i * BLOCK_LENGTH)
        : BLOCK_LENGTH
    }
  }
  return null
}

Piece.prototype.cancelBlock = function (offset) {
  var self = this
  if (!self._verifyOffset(offset)) {
    return false
  }

  var i = offset / BLOCK_LENGTH
  if (self.blocks[i] === BLOCK_RESERVED) {
    self.blocks[i] = BLOCK_BLANK
  }

  return true
}

Piece.prototype._reset = function () {
  var self = this
  self.verified = false
  self.blocks = new Buffer(Math.ceil(self.length / BLOCK_LENGTH))
  self.blocks.fill(0)
  self.blocksWritten = 0
}

Piece.prototype._verify = function () {
  var self = this
  if (self.verified) {
    return
  }

  self.verified = (sha1(self.buffer) === self.hash)
  if (self.verified) {
    self.emit('done')
  } else {
    self.emit('warning', new Error('piece ' + self.index + ' failed verification; ' + sha1(self.buffer) + ' expected ' + self.hash))
    self._reset()
  }
}

Piece.prototype._verifyOffset = function (offset) {
  if (offset % BLOCK_LENGTH === 0) {
    this._lazyAllocBuffer()
    return true
  } else {
    self.emit('warning', new Error('piece ' + self.index + ' invalid offset ' + offset + ' not multiple of ' + BLOCK_LENGTH + ' bytes'))
    return false
  }
}

Piece.prototype._verifyBlock = function (offset, buffer) {
  var self = this
  if ((self.length - offset) < BLOCK_LENGTH || buffer.length === BLOCK_LENGTH) {
    return true
  } else {
    self.emit('warning', new Error('piece ' + self.index + ' invalid block of size ' + buffer.length + ' bytes'))
    return false
  }
}

Piece.prototype._lazyAllocBuffer = function () {
  var self = this
  if (!self.buffer) {
    self.buffer = new Buffer(self.length)
  }
}

inherits(File, EventEmitter)

/**
 * A torrent file
 *
 * @param {Storage} storage       Storage container object
 * @param {Object}  file          the file object from the parsed torrent
 * @param {Array.<Piece>} pieces  backing pieces for this file
 * @param {number}  pieceLength   the length in bytes of a non-terminal piece
 */
function File (storage, file, pieces, pieceLength) {
  var self = this
  EventEmitter.call(self)

  self.storage = storage
  self.name = file.name
  self.path = file.path
  self.length = file.length
  self.offset = file.offset
  self.pieces = pieces
  self.pieceLength = pieceLength

  self.done = false

  self.pieces.forEach(function (piece) {
    piece.on('done', function () {
      self._checkDone()
    })
  })
}

/**
 * Selects the file to be downloaded, but at a lower priority than files with streams.
 * Useful if you know you need the file at a later stage.
 */
File.prototype.select = function () {
  var self = this

  self.storage.emit('select', self.pieces[0].index, self.pieces[self.pieces.length - 1].index, false)
}

/**
 * Deselects the file, which means it won't be downloaded unless someone creates a stream
 * for it.
 */
File.prototype.deselect = function () {
  var self = this

  self.storage.emit('deselect', self.pieces[0].index, self.pieces[self.pieces.length - 1].index, false)
}

/**
 * Create a readable stream to the file. Pieces needed by the stream will be prioritized
 * highly and fetched from the swarm first.
 *
 * @param {Object} opts
 * @param {number} opts.start stream slice of file, starting from this byte (inclusive)
 * @param {number} opts.end   stream slice of file, ending with this byte (inclusive)
 * @return {stream.Readable}
 */
File.prototype.createReadStream = function (opts) {
  var self = this
  opts = extend({
    pieceLength: self.pieceLength
  }, opts)

  var stream = new FileStream(self, opts)
  self.storage.emit('select', stream.startPiece, stream.endPiece, true, stream.notify.bind(stream))
  eos(stream, function () {
    self.storage.emit('deselect', stream.startPiece, stream.endPiece, true)
  })

  return stream
}

File.prototype._checkDone = function () {
  var self = this
  self.done = self.pieces.every(function (piece) {
    return piece.verified
  })
  if (self.done) {
    self.emit('done')
  }
}

inherits(Storage, EventEmitter)

/**
 * Storage for a torrent download. Handles the complexities of reading and writing
 * to pieces and files.
 *
 * @param {Object} parsedTorrent
 * @param {Object} opts
 */
function Storage (parsedTorrent, opts) {
  var self = this
  EventEmitter.call(self)
  opts = opts || {}

  self.bitfield = new BitField(parsedTorrent.pieces.length)

  self.done = false
  self.closed = false
  self.log = opts.log || console.log

  if (!opts.nobuffer) {
    self.buffer = new Buffer(parsedTorrent.length)
  }

  var pieceLength = parsedTorrent.pieceLength
  var lastPieceLength = parsedTorrent.lastPieceLength
  var numPieces = parsedTorrent.pieces.length

  self.pieces = parsedTorrent.pieces.map(function (hash, index) {
    var start = index * pieceLength
    var end = start + (index === numPieces - 1 ? lastPieceLength : pieceLength)

    // if we're backed by a buffer, the piece's buffer will reference the same memory
    // otherwise, the piece's buffer will be lazily created on demand
    var buffer = (self.buffer ? self.buffer.slice(start, end) : end - start)

    var piece = new Piece(index, hash, buffer)
    piece.on('done', self._onPieceDone.bind(self, piece))
    return piece
  })

  self.files = parsedTorrent.files.map(function (fileObj) {
    var start = fileObj.offset
    var end = start + fileObj.length

    var startPiece = Math.floor(start / pieceLength)
    var endPiece = Math.floor((end - 1) / pieceLength)
    var pieces = self.pieces.slice(startPiece, endPiece + 1)

    var file = new File(self, fileObj, pieces, pieceLength)
    file.on('done', self._onFileDone.bind(self, file))
    return file
  })
}

Storage.BLOCK_LENGTH = BLOCK_LENGTH

Object.defineProperty(Storage.prototype, 'downloaded', {
  get: function () {
    var self = this
    var downloaded = 0
    return self.pieces.reduce(function (total, piece) {
      return total + (piece.verified ? piece.length : piece.blocksWritten * BLOCK_LENGTH)
    }, 0)
  }
})

/**
 * The number of missing pieces. Used to implement "end game" mode.
 */
Object.defineProperty(Storage.prototype, 'numMissing', {
  get: function () {
    var self = this
    var numMissing = self.pieces.length
    for (var index = 0, len = self.pieces.length; index < len; index++) {
      numMissing -= self.bitfield.get(index)
    }
    return numMissing
  }
})

/**
 * Reads a block from a piece.
 *
 * @param {number}    index    piece index
 * @param {number}    offset   byte offset within piece
 * @param {number}    length   length in bytes to read from piece
 */
Storage.prototype.readBlock = function (index, offset, length, cb) {
  var self = this
  if (!cb) return console.error('Storage.readBlock requires a callback')

  var piece = self.pieces[index]
  if (!piece) return cb(new Error("invalid piece index " + index))

  piece.readBlock(offset, length, cb)
}

/**
 * Writes a block to a piece.
 *
 * @param {number}  index    piece index
 * @param {number}  offset   byte offset within piece
 * @param {Buffer}  buffer   buffer to write
 */
Storage.prototype.writeBlock = function (index, offset, buffer, cb) {
  var self = this
  if (!cb) cb = noop

  var piece = self.pieces[index]
  if (!piece) return cb(new Error("invalid piece index " + index))

  piece.writeBlock(offset, buffer, cb)
}

/**
 * Reads a piece or a range of a piece.
 *
 * @param {number}  index         piece index
 * @param {Object}  range         optional range within piece
 * @param {number}  range.offset  byte offset within piece
 * @param {number}  range.length  length in bytes to read from piece
 */
Storage.prototype.read = function (index, range, cb) {
  var self = this

  if (typeof range === "function") {
    cb = range
    range = null
  }

  if (!cb) return console.error('Storage.read requires a callback')

  var piece = self.pieces[index]
  if (!piece) return cb(new Error("invalid piece index " + index))
  if (!piece.verified) return cb(new Error("Storage.read called on incomplete piece " + index))

  var offset = 0
  var length = piece.length

  if (range) {
    offset = range.offset || 0
    length = range.length || length
  }

  if (piece.buffer) {
    // shortcut for piece with static backing buffer
    return cb(null, piece.buffer.slice(offset, offset + length))
  }

  var blocks = []
  function readNextBlock () {
    if (length <= 0) return cb(null, Buffer.concat(blocks))

    var blockOffset = offset
    var blockLength = Math.min(BLOCK_LENGTH, length)

    offset += blockLength
    length -= blockLength

    self.readBlock(index, blockOffset, blockLength, function (err, block) {
      if (err) return cb(err)

      blocks.push(block)
      readNextBlock()
    })
  }

  readNextBlock()
}

/**
 * Reserves a block from the given piece.
 *
 * @param {number}  index    piece index
 * @param {Boolean} endGame  whether or not end game mode is enabled
 *
 * @returns {Object} reservation with offset and length or null if failed.
 */
Storage.prototype.reserveBlock = function (index, endGame) {
  var self = this
  var piece = self.pieces[index]
  if (!piece) return null

  return piece.reserveBlock(endGame)
}

/**
 * Cancels a previous block reservation from the given piece.
 *
 * @param {number}  index   piece index
 * @param {number}  offset  byte offset of block in piece
 *
 * @returns {Boolean}
 */
Storage.prototype.cancelBlock = function (index, offset) {
  var self = this
  var piece = self.pieces[index]
  if (!piece) return false

  return piece.cancelBlock(offset)
}

/**
 * Removes and cleans up any backing store for this storage.
 */
Storage.prototype.remove = function (cb) {
  var self = this
  if (!cb) cb = noop

  cb(null)
}

/**
 * Closes the backing store for this storage.
 */
Storage.prototype.close = function (cb) {
  var self = this
  if (!cb) cb = noop

  self.closed = true
  cb(null)
}

//
// HELPER METHODS
//

Storage.prototype._onPieceDone = function (piece) {
  var self = this
  self.bitfield.set(piece.index)
  self.log('PIECE DONE', piece.index, '(' + self.numMissing + ' missing)')
  self.emit('piece', piece)
}

Storage.prototype._onFileDone = function (file) {
  var self = this
  self.log('FILE DONE', file.name, '(' + self.numMissing + ' missing)')
  self.emit('file', file)

  self._checkDone()
}

Storage.prototype._checkDone = function () {
  var self = this

  if (!self.done && self.files.every(function (file) { return file.done })) {
    self.done = true
    self.emit('done')
  }
}

function sha1 (buf) {
  return (new Rusha()).digestFromBuffer(buf)
}
