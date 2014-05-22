
var BitTorrentClient = require('../')
var test = require('tape')

// TODO: replace this with a test that can run offline
test('Download "Pride and Prejudice" by Jane Austen with rarest piece first strategy', function (t) {
  t.plan(4)

  var client = new BitTorrentClient()
  client.add('magnet:?xt=urn:btih:1e69917fbaa2c767bca463a96b5572785c6d8a12', {
    strategy: 'rarest'
  })

  client.on('torrent', function (torrent) {
    // torrent metadata has been fetched
    t.equal(torrent.name, 'Pride and Prejudice - Jane Austen - eBook [EPUB, MOBI]')

    var names = [
      'Pride and Prejudice - Jane Austen.epub',
      'Pride and Prejudice - Jane Austen.mobi'
    ]

    torrent.files.forEach(function (file, index) {
      t.equal(file.name, names[index])
    })

    torrent.once('done', function () {
      t.pass('torrent downloaded successfully!')
      client.destroy()
    })
  })
})

