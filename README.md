# bittorrent-client [![build](https://img.shields.io/travis/feross/bittorrent-client.svg)](https://travis-ci.org/feross/bittorrent-client) [![npm](https://img.shields.io/npm/v/bittorrent-client.svg)](https://npmjs.org/package/bittorrent-client) [![gittip](https://img.shields.io/gittip/feross.svg)](https://www.gittip.com/feross/)

### Fast, streaming torrent client

Simple, robust, torrent client that exposes files as streams so you can access file content before a torrent has finished downloading. This module is used by [WebTorrent](http://webtorrent.io) and heavily inspired by the excellent design of [torrent-stream](https://github.com/mafintosh/torrent-stream) by [@mafintosh](https://twitter.com/mafintosh).

### install

```
npm install bittorrent-client
```

### usage

Access files inside a torrent as node.js [readable streams](http://nodejs.org/api/stream.html#stream_class_stream_readable).

The client automatically connects to the
[DHT](http://www.bittorrent.org/beps/bep_0005.html) to fetch torrent metadata (if
necessary) and to discover new peers. If the magnet uri or .torrent file contains tracker
urls, the client automatically connects to trackers to discover new peers.

```js
var BitTorrentClient = require('bittorrent-client')

var client = BitTorrentClient()

// "Pride and Prejudice" by Jane Austen
client.add('magnet:?xt=urn:btih:1e69917fbaa2c767bca463a96b5572785c6d8a12')

client.on('torrent', function (torrent) {
  // torrent metadata has been fetched
  console.log(torrent.name)

  torrent.files.forEach(function (file) {
    console.log(file.name)
    // get a readable stream of the file content
    var stream = file.createReadStream()
  })
})
```

You can pass `start` and `end` options to `createReadStream` to stream only a slice of
a file.

```js
// get a stream containing bytess 100-1000 inclusive
var stream = file.createReadStream({
  start: 100
  end: 1000
})
```

By default, no files are downloaded until you call `file.createReadStream`. If you want to
download a particular file without creating a stream, call `file.select` and
`file.deselect`.

To download multiple torrents simulataneous, just **reuse the same instance of `Client`**.
This will improve the download speed, conserve system resources, and allow internal state like the DHT routing table to be re-used.

```js
// Sintel movie in 4K
var magnet = 'magnet:?xt=urn:btih:489a21c45f7eb13ad75b3b9bfa0132b1be035f62'

client.add(magnet, function (err, torrent) {
  if (!err) {
    // torrent metadata has been fetched
    console.log(torrent.name)
  }
})
```

You can also download from a local torrent file, or a URL to a torrent.

```js
var fs = require('fs')

var file = fs.readFileSync('/path/to/file.torrent')
client.add(file)

var url = 'http://releases.ubuntu.com/14.04/ubuntu-14.04-server-amd64.iso.torrent'
client.add(url)
```

### client api

#### `client = BitTorrentClient([opts])`

Create a new `bittorrent-client` instance.

If `opts` is specified, then the default options (shown below) will be overridden.

``` js
{
  maxDHT: 100,            // Max number of peers to find through DHT (across all torrents)
  maxPeers: 100,          // Max number of peers to connect to (per torrent)
  path: '/tmp/some-name', // Where to save the torrent file data
  peerId: '',             // Wire protocol peer ID (otherwise, randomly generated)
  nodeId: '',             // DHT protocol node ID (otherwise, randomly generated)
  trackers: true,         // Whether or not to enable trackers
  dht: true,              // Whether or not to enable DHT
  verify: true            // Verify previously stored data before starting
}
```

#### `client.on('torrent', function (torrent) {})`

Emitted when a torrent is ready to be used (i.e. metadata is available). See the torrent
section for more info on what methods a `torrent` has.

#### `client.add(torrentId, [opts], [function callback (err, torrent) {}])`

Add a new torrent to the client.

`torrentId` can be any of the following:

- info hash (as a hex string or Buffer)
- magnet uri (as a utf8 string)
- .torrent file (as a Buffer)

Optional `callback` is called when this torrent has been created. Note that the torrent
may not have downloaded metadata yet when the callback is called. To wait for a torrent
that is fully ready with metadata, files, etc., listen for the `torrent` event.

#### `client.remove(torrentId, [function callback (err) {}])`

Remove a torrent from the client. Destroy all connections to peers and delete all saved
file data. Optional `callback` is called when file data has been removed.

#### `client.destroy()`

Destroy the client, including all torrents and connections to peers.

#### `client.listen([port], function () {})`

Listen for incoming peers on the specified port. Port defaults to `6881`

#### `client.torrents[...]`

An array of all torrents in the client.

#### `client.get(torrentId)`

Return the torrent with the given `torrentId`. Easier than searching through the
`client.torrents` array by hand for the torrent you want.

#### `client.ratio`

Aggregate seed ratio for all torrents in the client.


### torrent api

#### `torrent.files[...]`

An array of all files in the torrent. See the file section for more info on what methods
the file has.

#### `torrent.swarm`

The attached [bittorrent-swarm](https://github.com/feross/bittorrent-swarm) instance.

#### `torrent.remove()`

Alias for `client.remove(torrent)`.

#### `torrent.addPeer(addr)`

Adds a peer to the underlying [bittorrent-swarm](https://github.com/feross/bittorrent-swarm) instance.

#### `torrent.select(start, end, priority, [notify])`

Selects a range of pieces to prioritize starting with `start` and ending with `end` (both inclusive)
at the given `priority`. `notify` is an optional callback to be called when the selection is updated
with new data.

#### `torrent.deselect(start, end, priority)`

Deprioritizes a range of previously selected pieces.

#### `torrent.critical(start, end)`

Marks a range of pieces as critical priority to be downloaded ASAP. From `start` to `end`
(both inclusive).


### file api

#### `file.name`

File name, as specified by the torrent. *Example: 'some-filename.txt'*

#### `file.path`

File path, as specified by the torrent. *Example: 'some-folder/some-filename.txt'*

#### `file.length`

File length (in bytes), as specified by the torrent. *Example: 12345*

#### `file.select()`

Selects the file to be downloaded, but at a lower priority than files with streams.
Useful if you know you need the file at a later stage.

#### `file.deselect()`

Deselects the file, which means it won't be downloaded unless someone creates a stream
for it.

#### `stream = file.createReadStream([opts])`

Create a [readable stream](http://nodejs.org/api/stream.html#stream_class_stream_readable)
to the file. Pieces needed by the stream will be prioritized highly and fetched from the
swarm first.

You can pass `opts` to stream only a slice of a file.

``` js
{
  start: startByte,
  end: endByte
}
```

Both `start` and `end` are inclusive.

### license

MIT. Copyright (c) [Feross Aboukhadijeh](http://feross.org).
