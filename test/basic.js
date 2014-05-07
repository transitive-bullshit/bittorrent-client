var BitTorrentClient = require('../')
var test = require('tape')

// TODO: replace this with a test that can run offline
test('Download "Pride and Prejudice" by Jane Austen', function (t) {
  t.plan(3)

  var client = BitTorrentClient()
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
    
    client.destroy()
  })
})
