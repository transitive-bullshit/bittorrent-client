/* vim: set ts=2 sw=2 sts=2 et: */

var BitTorrentClient = require('../')
var parseTorrent = require('parse-torrent')
var test = require('tape')
var fs = require('fs')

var leaves = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var leavesTorrent = parseTorrent(leaves)

// TODO: replace this with a test that can run offline
test('external download and transfer between local torrents', function (t) {
  t.plan(2)

  // clientA will download the torrent from external peers normally, whereas
  // the isolated clientB will download from its sole peer clientA.
  var clientA = new BitTorrentClient() // enable external peer discovery
  var clientB = new BitTorrentClient({ maxDHT: 0, trackersEnabled: false }) // disable external peer discovery

  // clientA starts with metadata from torrent file
  clientA.add(leaves)

  // clientB starts with infohash
  clientB.add(leavesTorrent.infoHash)

  clientA.on('error', function (err) { t.error(err) })
  clientB.on('error', function (err) { t.error(err) })

  clientA.on('listening', function (torrentA) {
    clientB.on('listening', function (torrentB) {
      // add each other as peers
      clientB.get(leavesTorrent.infoHash).addPeer('localhost:' + clientA.torrentPort)
      clientA.get(leavesTorrent.infoHash).addPeer('localhost:' + clientB.torrentPort)

      var torrentADone = false
      torrentA.once('done', function () {
        torrentADone = true
      })

      torrentB.once('done', function () {
        t.pass('clientB download successful')
        t.assert(torrentADone, 'clientA download successful')

        clientA.destroy()
        clientB.destroy()
      })
    })
  })
})
