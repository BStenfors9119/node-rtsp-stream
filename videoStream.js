var Mpeg1Muxer, STREAM_MAGIC_BYTES, NETWORK_LATENCY,
    VideoStream, events, util, net, ws

net = require('net')

ws = require('ws')

util = require('util')

events = require('events')

Mpeg1Muxer = require('./mpeg1muxer')

STREAM_MAGIC_BYTES = "jsmp" // Must be 4 bytes

NETWORK_LATENCY = 100;

VideoStream = function(options) {
  this.options = options
  this.name = options.name
  this.streamUrl = options.streamUrl
  this.width = options.width
  this.height = options.height
  this.wsPort = options.wsPort
  this.unixWsPort = options.unixWsPort
  this.inputStreamStarted = false
  this.stream = undefined
  this.tsrReceivers = []
  this.startMpeg1Stream()
  this.pipeStreamToSocketServer()
  return this
}

util.inherits(VideoStream, events.EventEmitter)

VideoStream.prototype.stop = function() {
  this.wsServer.close()
  this.stream.kill()
  this.inputStreamStarted = false
  return this
}

VideoStream.prototype.startMpeg1Stream = function() {
  var gettingInputData, gettingOutputData, inputData, outputData
  this.mpeg1Muxer = new Mpeg1Muxer({
    ffmpegOptions: this.options.ffmpegOptions,
    url: this.streamUrl,
    ffmpegPath: this.options.ffmpegPath == undefined ? "ffmpeg" : this.options.ffmpegPath
  })
  this.stream = this.mpeg1Muxer.stream
  if (this.inputStreamStarted) {
    return
  }
  this.mpeg1Muxer.on('mpeg1data', (data) => {
    return this.emit('camdata', data)
  })
  gettingInputData = false
  inputData = []
  gettingOutputData = false
  outputData = []
  this.mpeg1Muxer.on('ffmpegStderr', (data) => {
    var size
    data = data.toString()
    if (data.indexOf('Input #') !== -1) {
      gettingInputData = true
    }
    if (data.indexOf('Output #') !== -1) {
      gettingInputData = false
      gettingOutputData = true
    }
    if (data.indexOf('frame') === 0) {
      gettingOutputData = false
    }
    if (gettingInputData) {
      inputData.push(data.toString())
      size = data.match(/\d+x\d+/)
      if (size != null) {
        size = size[0].split('x')
        if (this.width == null) {
          this.width = parseInt(size[0], 10)
        }
        if (this.height == null) {
          return this.height = parseInt(size[1], 10)
        }
      }
    }
  })
  this.mpeg1Muxer.on('ffmpegStderr', function(data) {
    return global.process.stderr.write(data)
  })
  this.mpeg1Muxer.on('exitWithError', () => {
    return this.emit('exitWithError')
  })
  console.log('mpeg1Muxer started...');
  return this
}

VideoStream.prototype.pipeStreamToSocketServer = function() {
  let vs = this;
  this.wsServer = new ws.Server({
    port: this.wsPort
  })
  this.wsServer.on("connection", (socket, request) => {
    console.log('wsServer connection');
    return this.onSocketConnect(socket, request)
  })
  this.wsServer.broadcast = function(data, opts) {
    var results
    results = []
    let longestClientDelay = 0;
    if (vs.tsrReceivers.length > 0){
      longestClientDelay = vs.tsrReceivers.reduce((max, obj) => {
        return obj.delay > max ? obj.delay : max;
      }, 0);
    }

    for (let client of this.clients) {
      // console.log('looping clients...');
      if (client.readyState === 1) {
        // console.log('longestClientDelay: ', longestClientDelay);
        if (longestClientDelay !== 0) {
          const currentClient = vs.tsrReceivers.find(tsrRec => tsrRec.name === `${vs.name}-${client.remoteAddress}`);
          // console.log('currentClientDelay: ', currentClient, client.remoteAddress);
          const currentClientDelay = currentClient?.delay || 0;
          const delay = longestClientDelay > currentClientDelay ? longestClientDelay - currentClientDelay : 0;
          // console.log('broadcast delay: ', currentClientDelay, longestClientDelay, delay);
          // console.log('broadcast delay', delay);
          setTimeout(() => {
            const message = {frame: data, ts: Date.now() + NETWORK_LATENCY};
            results.push(client.send(JSON.stringify(message), opts))
          }, delay);
        } else {
            const message = {frame: data, ts: Date.now() + NETWORK_LATENCY};
            results.push(client.send(JSON.stringify(message), opts))
        }
        // console.log(message);
      } else {
        results.push(console.log("Error: Client from remoteAddress " + client.remoteAddress + " not connected."))
      }
    }
    return results
  }
  return this.on('camdata', (data) => {
    return this.wsServer.broadcast(data)
  })
}

VideoStream.prototype.onSocketConnect = function(socket, request) {
  var streamHeader
  let vs = this;
  // Send magic bytes and video size to the newly connected socket
  // struct { char magic[4]; unsigned short width, height;}
  streamHeader = new Buffer(8)
  streamHeader.write(STREAM_MAGIC_BYTES)
  streamHeader.writeUInt16BE(this.width, 4)
  streamHeader.writeUInt16BE(this.height, 6)
  socket.send(streamHeader, {
    binary: true
  })
  console.log(`${this.name}: New WebSocket Connection (` + this.wsServer.clients.size + " total)")

  // console.log('ws socket: ', request.connection);
  socket.remoteAddress = request.connection.remoteAddress

  // socket.on('message', data => {
  //   const connectingClientInfo = JSON.parse(data.toString());
  //   const currentLapse = connectingClientInfo.timeLapse;
  //   let delay = 0;
  //   if (connectingClientInfo.event === 'ack') {
  //     if (this.clientDelays.size >= 1) {
  //       for (const client of this.clientDelays) {
  //         const existingClientTimeLapse = client.timeLapse;
  //         const connectingClientTimeLapse = connectingClientInfo.timeLapse;
  //         if (existingClientTimeLapse > connectingClientTimeLapse) {
  //           // console.log('connecting client is faster: ', client.timeLapse, connectingClientInfo.timeLapse);
  //           delay = parseFloat(existingClientTimeLapse) - parseFloat(connectingClientTimeLapse);
  //         }
  //       }
  //     }
  //
  //     const finalClient = {id: connectingClientInfo.id, delay: delay,
  //       timeLapse: connectingClientInfo.timeLapse, client: socket};
  //     this.clientDelays.add(finalClient);
  //
  //     socket.send(JSON.stringify({'event': 'delay_calc', delayed: delay}))
  //     // console.log('client info: ', finalClient);
  //   }
  // })

  socket.on('message', data => {
    const connectingClientInfo = JSON.parse(data.toString());
    const currentLapse = connectingClientInfo.timeLapse;
    let delay = 0;
    // console.log('times: ', connectingClientInfo.timeLapse, clients.size);
    if (connectingClientInfo.event === 'ack') {
      const startTime = process.hrtime();
      const elapsedSeconds = startTime[0]; // seconds
      const elapsedNanoseconds = startTime[1]; // nanoseconds
      const startTimeInMilliseconds = elapsedSeconds * 1000 + elapsedNanoseconds / 1e6;

      delay = startTimeInMilliseconds - connectingClientInfo.clientStartTime;

      const finalClient = {
        id: connectingClientInfo.id,
        name: `${vs.name}-${socket.remoteAddress}`,
        delay: delay,
        clientStartTime: connectingClientInfo.clientStartTime,
        serverTime: startTimeInMilliseconds,
        client: socket
      };

      console.log(`final client ${finalClient.name}`, finalClient.delay, startTimeInMilliseconds, connectingClientInfo.clientStartTime);

      vs.tsrReceivers.push(finalClient);

      socket.send(JSON.stringify({
        'event': 'delay_calc',
        clientStart: finalClient.clientStartTime,
        serverTs: finalClient.serverTime
      }))
    }
  })

  return socket.on("close", (code, message) => {
    return console.log(`${this.name}: Disconnected WebSocket (` + this.wsServer.clients.size + " total)")
  })
}

module.exports = VideoStream
