module.exports = FileStream

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var stream = require('stream')

inherits(FileStream, stream.Readable)

/**
 * A readable stream of a torrent file.
 *
 * @param {Object} file
 * @param {number} opts.start stream slice of file, starting from this byte (inclusive)
 * @param {number} opts.end   stream slice of file, ending with this byte (inclusive)
 */
function FileStream (file, opts) {
  var self = this
  if (!(this instanceof FileStream)) return new FileStream(file, opts)
  stream.Readable.call(this)

  if (!opts) opts = {}
  if (!opts.start) opts.start = 0
  if (!opts.end || typeof opts.end !== 'number') opts.end = file.length - 1

  var offset = opts.start + file.offset
  var pieceLength = opts.pieceLength

  this.length = opts.end - opts.start + 1
  this.startPiece = (offset / pieceLength) | 0
  this.endPiece = ((opts.end + file.offset) / pieceLength) | 0
  this._storage = file.storage
  this._piece = this.startPiece
  this._missing = this.length
  this._reading = false
  this._notifying = false
  this._destroyed = false
  this._critical = Math.min(1024 * 1024 / pieceLength, 2) | 0
  this._offset = offset - this.startPiece * pieceLength
}

FileStream.prototype._read = function() {
  if (this._reading) return
  this._reading = true
  this.notify()
}

FileStream.prototype.notify = function() {
  if (!this._reading || !this._missing) return
  if (!this._storage.bitfield.get(this._piece)) return this._storage.critical(this._piece, this._critical)

  var self = this

  if (this._notifying) return
  this._notifying = true

  this._storage.read(this._piece++, function(err, buffer) {
    self._notifying = false

    if (self._destroyed || !self._reading) return

    if (err) return self.destroy(err)

    if (self._offset) {
      buffer = buffer.slice(self._offset)
      self._offset = 0
    }

    if (self._missing < buffer.length) buffer = buffer.slice(0, self._missing)

    self._missing -= buffer.length

    if (!self._missing) {
      self.push(buffer)
      self.push(null)
      return
    }

    self._reading = false
    self.push(buffer)
  })
}

FileStream.prototype.destroy = function() {
  if (this._destroyed) return
  this._destroyed = true
  this.emit('close')
}

