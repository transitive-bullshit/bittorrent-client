/* vim: set ts=2 sw=2 sts=2 et: */

var BitTorrentClient = require('../')
var parseTorrent = require('parse-torrent')
var test = require('tape')
var fs = require('fs')

var leaves = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var leavesTorrent = parseTorrent(leaves)

test('ut_metadata transfer between local torrents', function (t) {
  t.plan(5)

  var clientA = new BitTorrentClient({ maxDHT: 0, trackersEnabled: false }) // disable DHT and trackers
  var clientB = new BitTorrentClient({ maxDHT: 0, trackersEnabled: false }) // disable DHT and trackers

  clientA.on('torrent', function (torrent) {
    t.pass('clientA must still emit torrent event')
  })

  // clientA starts with metadata from torrent file
  clientA.add(leaves)

  // clientB starts with infohash
  clientB.add(leavesTorrent.infoHash)

  clientA.on('error', function (err) { t.error(err) })
  clientB.on('error', function (err) { t.error(err) })

  clientA.on('listening', function (torrentA) {
    clientB.on('listening', function (torrentB) {
      // add each other as sole peers
      clientB.get(leavesTorrent.infoHash).addPeer('localhost:' + clientA.torrentPort)
      clientA.get(leavesTorrent.infoHash).addPeer('localhost:' + clientB.torrentPort)

      clientB.on('torrent', function () {
        t.equal(torrentA.parsedTorrent.name, torrentB.parsedTorrent.name)
        t.equal(torrentA.parsedTorrent.length, torrentB.parsedTorrent.length)
        t.equal(torrentA.parsedTorrent.lastPieceLength, torrentB.parsedTorrent.lastPieceLength)
        t.equal(torrentA.parsedTorrent.pieces.length, torrentB.parsedTorrent.pieces.length)

        clientA.destroy()
        clientB.destroy()
      })
    })
  })
})
