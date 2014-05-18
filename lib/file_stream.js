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
  if (!(self instanceof FileStream)) return new FileStream(file, opts)
  stream.Readable.call(self, opts)

  if (!opts) opts = {}
  if (!opts.start) opts.start = 0
  if (!opts.end || typeof opts.end !== 'number') opts.end = file.length - 1

  var offset = opts.start + file.offset
  var pieceLength = opts.pieceLength

  self.length = opts.end - opts.start + 1
  self.startPiece = (offset / pieceLength) | 0
  self.endPiece = ((opts.end + file.offset) / pieceLength) | 0
  self._storage = file.storage
  self._piece = self.startPiece
  self._missing = self.length
  self._reading = false
  self._notifying = false
  self._destroyed = false
  self._critical = Math.min(1024 * 1024 / pieceLength, 2) | 0
  self._offset = offset - self.startPiece * pieceLength
}

FileStream.prototype._read = function () {
  var self = this
  if (self._reading) return
  self._reading = true
  self.notify()
}

FileStream.prototype.notify = function () {
  var self = this

  if (!self._reading || !self._missing) return
  if (!self._storage.bitfield.get(self._piece)) return self._storage.emit('critical', self._piece, self._critical)

  if (self._notifying) return
  self._notifying = true

  self._storage.read(self._piece++, function (err, buffer) {
    self._notifying = false

    if (self._destroyed || !self._reading) return

    if (err) {
      self._storage.emit('error', err)
      return self.destroy(err)
    }

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

FileStream.prototype.destroy = function () {
  var self = this
  if (self._destroyed) return
  self._destroyed = true
  self.emit('close')
}
