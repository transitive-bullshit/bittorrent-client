var auto = require('run-auto')
var BitTorrentClient = require('../')
var BlockStream = require('block-stream')
var extend = require('extend.js')
var fs = require('fs')
var parseTorrent = require('parse-torrent')
var portfinder = require('portfinder')
var test = require('tape')
var TrackerServer = require('bittorrent-tracker').Server

// TODO: add a download test for DHT

var leavesFile = __dirname + '/torrents/Leaves of Grass by Walt Whitman.epub'
var leavesTorrent = fs.readFileSync(__dirname + '/torrents/leaves.torrent')
var leavesParsed = parseTorrent(leavesTorrent)

var BLOCK_LENGTH = 16 * 1024
function writeToStorage (storage, file, cb) {
  var pieceIndex = 0
  fs.createReadStream(file)
    .pipe(new BlockStream(leavesParsed.pieceLength, { nopad: true }))
    .on('data', function (piece) {
      var index = pieceIndex
      pieceIndex += 1

      var blockIndex = 0
      var s = new BlockStream(BLOCK_LENGTH, { nopad: true })
      s.on('data', function (block) {
        var offset = blockIndex * BLOCK_LENGTH
        blockIndex += 1

        storage.writeBlock(index, offset, block)
      })
      s.write(piece)
      s.end()
    })
    .on('end', function () {
      cb(null)
    })
    .on('error', function (err) {
      cb(err)
    })
}

function downloadTest (t, trackerType) {
  t.plan(8)

  // clone the parsed torrent for this test since we're going to modify it
  var parsed = extend({}, leavesParsed)

  var trackerStartCount = 0

  auto({
    trackerPort: function (cb) {
      portfinder.getPort(cb)
    },

    tracker: ['trackerPort', function (cb, r) {
      var tracker = new TrackerServer(
        trackerType === 'udp' ? { http: false } : { udp: false }
      )

      // Overwrite announce with our local tracker
      parsed.announce = [ trackerType + '://127.0.0.1:' + r.trackerPort ]
      parsed.announceList = [ parsed.announce ]

      tracker.on('error', function (err) {
        t.fail(err)
      })

      tracker.on('start', function (addr) {
        trackerStartCount += 1
      })

      tracker.listen(r.trackerPort, function () {
        cb(null, tracker)
      })
    }],

    client1: ['tracker', function (cb, r) {
      var client1 = new BitTorrentClient({ dht: false })

      client1.add(parsed)

      client1.on('torrent', function (torrent) {
        // torrent metadata has been fetched -- sanity check it
        t.equal(torrent.name, 'Leaves of Grass by Walt Whitman.epub')

        var names = [
          'Leaves of Grass by Walt Whitman.epub'
        ]

        t.deepEqual(torrent.files.map(function (file) { return file.name }), names)

        writeToStorage(torrent.storage, leavesFile, function (err) {
          cb(err, client1)
        })
      })
    }],

    client2: ['client1', function (cb, r) {
      var client2 = new BitTorrentClient({ dht: false })

      client2.add(parsed)

      client2.on('torrent', function (torrent) {
        torrent.files.forEach(function (file) {
          file.createReadStream()
        })

        torrent.once('done', function () {
          t.pass('client2 downloaded torrent from client1')
          cb(null, client2)
        })
      })
    }]

  }, function (err, r) {
    t.error(err)
    t.equal(trackerStartCount, 2)

    r.tracker.close(function () {
      t.pass('tracker closed')
    })
    r.client1.destroy(function () {
      t.pass('client1 destroyed')
    })
    r.client2.destroy(function () {
      t.pass('client2 destroyed')
    })
  })
}

test('Basic download via UDP tracker ("Leaves of Grass" by Walt Whitman)', function (t) {
  downloadTest(t, 'udp')
})

test('Basic download via HTTP tracker ("Leaves of Grass" by Walt Whitman)', function (t) {
  downloadTest(t, 'http')
})
