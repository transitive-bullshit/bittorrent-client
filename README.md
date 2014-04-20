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
var TorrentClient = require('bittorrent-client')

// "Pride and Prejudice" by Jane Austen
var magnet = 'magnet:?xt=urn:btih:1e69917fbaa2c767bca463a96b5572785c6d8a12'
var client = TorrentClient(magnet)

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

client.add(magnet)
client.on('torrent', function (torrent) {
  // torrent metadata has been fetched
  console.log(torrent.name)
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

#### `client = TorrentClient([torrentId], [opts])`

Create a new `bittorrent-client` instance.

If `torrentId` is specified, then the client will start with this torrent already added.
`torrentId` can be any of the following:

- info hash (hex string/Buffer)
- magnet uri (string)
- path to .torrent file on filesystem, or http url (string)
- buffer of .torrent file contents
- parsed torrent object from
  [parse-torrent](https://www.npmjs.org/package/parse-torrent) module

If `opts` is specified, then the default options (shown below) will be overridden.

``` js
{
  maxPeers: 100,          // Max number of peers to connect to (per torrent)
  path: '/tmp/some-name', // Where to save the torrent file data
  verify: true,           // Verify previously stored data before starting
  maxDHT: 100,            // Max number of DHT nodes to connect to (across all torrents)
  tracker: true           // Whether or not to use a tracker
}
```

#### `client.on('torrent', function (torrent) {})`

Emitted when a torrent is ready to be used. See the torrent section for more info on what
methods a `torrent` has.

#### `client.torrents[...]`

An array of all torrents in the client.

#### `client.add(torrentId)`

Add a new torrent to the client. `torrentId` can be any type accepted by the constructor.
`client.add` is called internally when a `torrentId` is passed into the constructor.

#### `client.remove(torrentId, [function (err) {}])`

Remove a torrent from the client. Destroy all connections to peers and delete all saved
file data. Optional callback is called when file data has been removed.

#### `client.destroy()`

Destroy the client, including all torrents and connections to peers.

#### `client.listen([port], function () {})`

Listen for incoming peers on the specified port. Port defaults to `6881`

### torrent api

#### `torrent.files[...]`

An array of all files in the torrent. See the file section for more info on what methods
the file has.

#### `torrent.swarm`

The attached [bittorrent-swarm](https://github.com/feross/bittorrent-swarm) instance.

#### `torrent.remove()`

Alias for `client.remove(torrent)`.

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
network first.

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
