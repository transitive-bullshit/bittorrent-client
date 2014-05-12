module.exports = Storage

var BitField = require('bitfield')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var Rusha = require('rusha-browserify') // Fast SHA1 (works in browser)
var stream = require('stream')

var BLOCK_LENGTH = 16 * 1024

var BLOCK_BLANK = 0
var BLOCK_RESERVED = 1
var BLOCK_WRITTEN = 2

inherits(Piece, EventEmitter)

/**
 * A torrent piece
 *
 * @param {number} index  piece index
 * @param {string} hash   sha1 hash (hex) for this piece
 * @param {Buffer} buffer backing buffer for this piece
 */
function Piece (index, hash, buffer) {
  var self = this
  EventEmitter.call(self)

  self.index = index
  self.hash = hash
  self.buffer = buffer

  self.length = buffer.length
  self._reset()
}

Piece.prototype.readBlock = function (offset, length) {
  var self = this
  if (!self._verifyOffset(offset)) {
    return
  }
  return self.buffer.slice(offset, offset + length)
}

Piece.prototype.writeBlock = function (offset, buffer) {
  var self = this
  if (!self._verifyOffset(offset) || !self._verifyBlock(offset, buffer)) {
    return false
  }

  var i = offset / BLOCK_LENGTH
  if (self.blocks[i] === BLOCK_WRITTEN) {
    return true
  }

  buffer.copy(self.buffer, offset)
  self.blocks[i] = BLOCK_WRITTEN
  self.blocksWritten += 1

  if (self.blocksWritten === self.blocks.length) {
    self._verify()
  }

  return true
}

Piece.prototype.selectBlock = function (endGame) {
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

Piece.prototype.deselectBlock = function (offset) {
  var self = this
  if (!self._verifyOffset(offset)) {
    return
  }

  var i = offset / BLOCK_LENGTH
  if (self.blocks[i] === BLOCK_RESERVED) {
    self.blocks[i] = BLOCK_BLANK
  }
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
    console.error('piece', self.index, 'failed verification', sha1(self.buffer), 'expected', self.hash)
    self._reset()
  }
}

Piece.prototype._verifyOffset = function (offset) {
  if (offset % BLOCK_LENGTH === 0) {
    return true
  } else {
    console.error('invalid offset', offset, 'not multiple of', BLOCK_LENGTH, 'bytes')
    return false
  }
}

Piece.prototype._verifyBlock = function (offset, buffer) {
  var self = this
  if ((self.length - offset) < BLOCK_LENGTH || buffer.length === BLOCK_LENGTH) {
    return true
  } else {
    console.error('invalid block of size', buffer.length, 'bytes')
    return false
  }
}

inherits(File, EventEmitter)

/**
 * A torrent file
 *
 * @param {Object} file           the file object from the parsed torrent
 * @param {Buffer} buffer         backing buffer for this file
 * @param {Array.<Piece>} pieces  backing pieces for this file
 */
function File (file, buffer, pieces) {
  var self = this
  EventEmitter.call(self)

  self.name = file.name
  self.path = file.path
  self.length = file.length
  self.offset = file.offset
  self.buffer = buffer
  self.pieces = pieces

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

}

/**
 * Deselects the file, which means it won't be downloaded unless someone creates a stream
 * for it.
 */
File.prototype.deselect = function () {
  var self = this

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

  var pieceLength = parsedTorrent.pieceLength
  var lastPieceLength = parsedTorrent.lastPieceLength

  self.buffer = new Buffer(parsedTorrent.length)
  self.bitfield = new BitField(parsedTorrent.pieces.length)

  self.done = false
  self.log = opts.log || console.log
  
  var numPieces = parsedTorrent.pieces.length

  self.pieces = parsedTorrent.pieces.map(function (hash, index) {
    var start = index * pieceLength
    var end = start + (index === numPieces - 1 ? lastPieceLength : pieceLength)
    var buffer = self.buffer.slice(start, end) // references same memory

    var piece = new Piece(index, hash, buffer)
    piece.on('done', self._onPieceDone.bind(self, piece))
    return piece
  })

  self.files = parsedTorrent.files.map(function (fileObj) {
    var start = fileObj.offset
    var end = start + fileObj.length
    var buffer = self.buffer.slice(start, end) // references same memory

    var startPiece = Math.floor(start / pieceLength)
    var endPiece = Math.floor((end - 1) / pieceLength)
    var pieces = self.pieces.slice(startPiece, endPiece + 1)

    var file = new File(fileObj, buffer, pieces)
    file.on('done', self._onFileDone.bind(self, file))
    return file
  })
}

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

Storage.prototype.readBlock = function (index, offset, length) {
  var self = this
  var piece = self.pieces[index]
  if (!piece) {
    return null
  }
  return piece.readBlock(offset, length)
}

Storage.prototype.writeBlock = function (index, offset, buffer) {
  var self = this
  var piece = self.pieces[index]
  if (!piece) {
    return false
  }
  return piece.writeBlock(offset, buffer)
}

Storage.prototype.selectBlock = function (index, endGame) {
  var self = this
  var piece = self.pieces[index]
  if (!piece) {
    return null
  }
  return piece.selectBlock(endGame)
}

Storage.prototype.deselectBlock = function (index, offset) {
  var self = this
  var piece = self.pieces[index]
  if (!piece) {
    return
  }
  piece.deselectBlock(offset)
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
