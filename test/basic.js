
var BitTorrentClient = require('../')
var parseTorrent = require('parse-torrent')
var test = require('tape')
var fs = require('fs')

var leaves = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var leavesTorrent = parseTorrent(leaves)
var leavesInfoHash = 'd2474e86c95b19b8bcfdb92bc12c9d44667cfa36'

test('Test supported torrentInfo types', function (t) {
  t.plan(4)

  function verify (client, torrent) {
    t.equal(torrent.infoHash, leavesInfoHash)
    client.destroy()
  }

  // info hash as a hex string
  var client1 = BitTorrentClient()
    .add(leavesInfoHash)
    .once('addTorrent', function (torrent) {
      verify(client1, torrent)
    })

  // info hash as a buffer
  var client2 = BitTorrentClient()
    .add(new Buffer(leavesInfoHash, 'hex'))
    .once('addTorrent', function (torrent) {
      verify(client2, torrent)
    })

  // magnet uri (as a utf8 string)
  var client3 = BitTorrentClient()
    .add('magnet:?xt=urn:btih:' + leavesInfoHash)
    .once('addTorrent', function (torrent) {
      verify(client3, torrent)
    })

  // .torrent file (as a Buffer)
  var client4 = BitTorrentClient()
    .add(leaves)
    .once('addTorrent', function (torrent) {
      verify(client4, torrent)
    })
})

// TODO: replace this with a test that can run offline
test('Download "Pride and Prejudice" by Jane Austen', function (t) {
  t.plan(4)

  var client = new BitTorrentClient()
  client.add('magnet:?xt=urn:btih:1e69917fbaa2c767bca463a96b5572785c6d8a12')

  client.on('torrent', function (torrent) {
    // torrent metadata has been fetched
    t.equal(torrent.name, 'Pride and Prejudice - Jane Austen - eBook [EPUB, MOBI]')

    var names = [
      'Pride and Prejudice - Jane Austen.epub',
      'Pride and Prejudice - Jane Austen.mobi'
    ]

    torrent.files.forEach(function (file, index) {
      t.equal(file.name, names[index])
      // get a readable stream of the file content
      var stream = file.createReadStream()
    })

    torrent.once('done', function () {
      t.pass('torrent downloaded successfully!')
      client.destroy()
    })
  })
})

// TODO: replace this with a test that can run offline
test('Download "Leaves of Grass" by Walt Whitman', function (t) {
  t.plan(3)

  var client = new BitTorrentClient()

  client.add(leavesTorrent.infoHash)

  client.on('error', function (err) { t.error(err) })

  client.on('torrent', function (torrent) {
    t.equal(torrent.name, 'Leaves of Grass by Walt Whitman.epub')

    var names = [
      'Leaves of Grass by Walt Whitman.epub'
    ]

    torrent.files.forEach(function (file, index) {
      t.equal(file.name, names[index])

      // get a readable stream of the file content
      var stream = file.createReadStream()
    })

    torrent.once('done', function () {
      t.pass('torrent downloaded successfully!')
      client.destroy()
    })
  })
})

