var BitTorrentClient = require('../')
var parseTorrent = require('parse-torrent')
var test = require('tape')
var fs = require('fs')

var leaves = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var leavesTorrent = parseTorrent(leaves)

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