var BitTorrentClient = require('../')
var test = require('tape')

// TODO: replace this with a test that can run offline
test('Download "Pride and Prejudice" by Jane Austen', function (t) {
  t.plan(2)

  var client = BitTorrentClient()
  client.add('magnet:?xt=urn:btih:1e69917fbaa2c767bca463a96b5572785c6d8a12')

  client.on('torrent', function (torrent) {
    // torrent metadata has been fetched
    t.equal(torrent.name, 'Pride and Prejudice')

    torrent.files.forEach(function (file) {
      t.equal(file.name, 'Pride and Prejudice')
      // get a readable stream of the file content
      var stream = file.createReadStream()
    })
  })
})
