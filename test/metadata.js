var BitTorrentClient = require('../')
var parseTorrent = require('parse-torrent')
var test = require('tape')
var fs = require('fs')

var leaves = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var leavesTorrent = parseTorrent(leaves)

test('ut_metadata transfer between local torrents', function (t) {
  t.plan(3)

  var clientA = new BitTorrentClient({ dht: false, trackers: false }) // disable DHT and trackers
  var clientB = new BitTorrentClient({ dht: false, trackers: false }) // disable DHT and trackers

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
    t.deepEqual(torrentA.parsedTorrent.info, leavesTorrent.info)

    clientB.on('listening', function (torrentB) {
      // add each other as sole peers
      clientB.get(leavesTorrent.infoHash).addPeer('127.0.0.1:' + clientA.torrentPort)
      clientA.get(leavesTorrent.infoHash).addPeer('127.0.0.1:' + clientB.torrentPort)

      clientB.on('torrent', function () {
        t.deepEqual(torrentA.parsedTorrent.info, torrentB.parsedTorrent.info)

        clientA.destroy()
        clientB.destroy()
      })
    })
  })
})
