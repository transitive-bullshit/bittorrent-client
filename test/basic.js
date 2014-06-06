
var BitTorrentClient = require('../')
var parseTorrent = require('parse-torrent')
var test = require('tape')
var fs = require('fs')

var leaves = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var leavesTorrent = parseTorrent(leaves)

test('Test supported torrentInfo types', function (t) {
  t.plan(5)

  function verify (client, torrent) {
    t.equal(torrent.infoHash, leavesTorrent.infoHash)
    client.destroy()
  }

  // info hash (as a hex string)
  var client1 = BitTorrentClient({ dht: false, trackers: false })
    .add(leavesTorrent.infoHash)
    .once('addTorrent', function (torrent) {
      verify(client1, torrent)
    })

  // info hash (as a Buffer)
  var client2 = BitTorrentClient({ dht: false, trackers: false })
    .add(new Buffer(leavesTorrent.infoHash, 'hex'))
    .once('addTorrent', function (torrent) {
      verify(client2, torrent)
    })

  // magnet uri (as a utf8 string)
  var client3 = BitTorrentClient({ dht: false, trackers: false })
    .add('magnet:?xt=urn:btih:' + leavesTorrent.infoHash)
    .once('addTorrent', function (torrent) {
      verify(client3, torrent)
    })

  // .torrent file (as a Buffer)
  var client4 = BitTorrentClient({ dht: false, trackers: false })
    .add(leaves)
    .once('addTorrent', function (torrent) {
      verify(client4, torrent)
    })

  // parsed torrent (as an Object)
  var client5 = BitTorrentClient({ dht: false, trackers: false })
    .add(leavesTorrent)
    .once('addTorrent', function (torrent) {
      verify(client5, torrent)
    })
})
