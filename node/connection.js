// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var assert = require('assert');
var bufrw = require('bufrw');
var ReadMachine = require('bufrw/stream/read_machine');
var inherits = require('util').inherits;

var v2 = require('./v2');
var errors = require('./errors');
var States = require('./reqres_states');

var TChannelConnectionBase = require('./connection_base');

function TChannelConnection(channel, socket, direction, remoteAddr) {
    assert(remoteAddr !== channel.hostPort, 'refusing to create self connection');

    var self = this;
    TChannelConnectionBase.call(self, channel, direction, remoteAddr);
    self.identifiedEvent = self.defineEvent('identified');

    self.socket = socket;

    var opts = {
        logger: self.channel.logger,
        random: self.channel.random,
        timers: self.channel.timers,
        hostPort: self.channel.hostPort,
        tracer: self.tracer,
        connection: self
    };
    // jshint forin:false
    for (var prop in self.options) {
        opts[prop] = self.options[prop];
    }
    // jshint forin:true
    self.handler = new v2.Handler(opts);

    self.mach = ReadMachine(bufrw.UInt16BE, v2.Frame.RW);

    self.setupSocket();
    self.setupHandler();
    self.start();
}
inherits(TChannelConnection, TChannelConnectionBase);

TChannelConnection.prototype.setupSocket = function setupSocket() {
    var self = this;

    self.socket.setNoDelay(true);
    self.socket.on('data', onSocketChunk);
    self.socket.on('close', onSocketClose);
    self.socket.on('error', onSocketError);

    function onSocketChunk(chunk) {
        self.mach.handleChunk(chunk, chunkHandled);
    }

    function chunkHandled(err) {
        if (err) {
            self.resetAll(errors.TChannelReadProtocolError(err, {
                remoteName: self.remoteName,
                localName: self.channel.hostPort
            }));
            self.socket.destroy();
        }
    }

    function onSocketClose() {
        self.resetAll(errors.SocketClosedError({
            reason: 'remote closed',
            remoteAddr: self.remoteAddr,
            direction: self.direction,
            remoteName: self.remoteName
        }));
        if (self.remoteName === '0.0.0.0:0') {
            self.channel.peers.delete(self.remoteAddr);
        }
    }

    function onSocketError(err) {
        self.onSocketError(err);
    }
};

TChannelConnection.prototype.setupHandler = function setupHandler() {
    var self = this;

    self.handler.write = function write(buf, done) {
        self.socket.write(buf, null, done);
    };

    self.mach.emit = handleReadFrame;

    self.handler.writeErrorEvent.on(onWriteError);
    self.handler.errorEvent.on(onHandlerError);
    self.handler.callIncomingRequestEvent.on(onCallRequest);
    self.handler.callIncomingResponseEvent.on(onCallResponse);
    self.handler.pingIncomingResponseEvent.on(onPingResponse);
    self.handler.callIncomingErrorEvent.on(onCallError);
    self.timedOutEvent.on(onTimedOut);

    // TODO: restore dumping from old:
    // var stream = self.socket;
    // if (dumpEnabled) {
    //     stream = stream.pipe(Spy(process.stdout, {
    //         prefix: '>>> ' + self.remoteAddr + ' '
    //     }));
    // }
    // stream = stream
    //     .pipe(self.reader)
    //     .pipe(self.handler)
    //     ;
    // if (dumpEnabled) {
    //     stream = stream.pipe(Spy(process.stdout, {
    //         prefix: '<<< ' + self.remoteAddr + ' '
    //     }));
    // }
    // stream = stream
    //     .pipe(self.socket)
    //     ;

    function onTimedOut(err) {
        self.onTimedOut(err);
    }

    function onWriteError(err) {
        self.onWriteError(err);
    }

    function onHandlerError(err) {
        self.onHandlerError(err);
    }

    function handleReadFrame(frame) {
        self.handleReadFrame(frame);
    }

    function onCallRequest(req) {
        self.handleCallRequest(req);
    }

    function onCallResponse(res) {
        self.onCallResponse(res);
    }

    function onPingResponse(res) {
        self.handlePingResponse(res);
    }

    function onCallError(err) {
        self.onCallError(err);
    }
};

TChannelConnection.prototype.onTimedOut = function onTimedOut(err) {
    var self = this;

    self.logger.warn('destroying socket from timeouts', {
        hostPort: self.channel.hostPort
    });
    self.resetAll(err);
    self.socket.destroy();
};

TChannelConnection.prototype.onWriteError = function onWriteError(err) {
    var self = this;
    self.resetAll(errors.TChannelWriteProtocolError(err, {
        remoteName: self.remoteName,
        localName: self.channel.hostPort
    }));
    self.socket.destroy();
};

TChannelConnection.prototype.onHandlerError = function onHandlerError(err) {
    var self = this;
    self.resetAll(err);
    // resetAll() does not close the socket
    self.socket.destroy();
};

TChannelConnectionBase.prototype.handlePingResponse = function handlePingResponse(resFrame) {
    var self = this;
    // TODO: explicit type
    self.pingResponseEvent.emit(self, {id: resFrame.id});
};

TChannelConnection.prototype.handleReadFrame = function handleReadFrame(frame) {
    var self = this;
    if (!self.closing) {
        self.ops.lastTimeoutTime = 0;
    }
    self.handler.handleFrame(frame, handledFrame);
    function handledFrame(err) {
        if (err) self.onHandlerError(err);
    }
};

TChannelConnection.prototype.onCallResponse = function onCallResponse(res) {
    var self = this;

    var called = false;
    var req = self.ops.getOutReq(res.id);

    if (res.state === States.Done || res.state === States.Error) {
        popOutReq();
    } else {
        res.errorEvent.on(popOutReq);
        res.finishEvent.on(popOutReq);
    }

    if (!req) {
        return;
    }

    if (self.tracer) {
        // TODO: better annotations
        req.span.annotate('cr');
        self.tracer.report(req.span);
        res.span = req.span;
    }

    req.emitResponse(res);

    function popOutReq() {
        if (called) {
            return;
        }

        called = true;

        self.ops.popOutReq(res.id, {
            responseId: res.id,
            code: res.code,
            arg1: Buffer.isBuffer(res.arg1) ?
                String(res.arg1) : 'streamed-arg1',
            info: 'got call response for unknown id'
        });
    }
};

TChannelConnection.prototype.ping = function ping() {
    var self = this;
    return self.handler.sendPingRequest();
};

TChannelConnection.prototype.onCallError = function onCallError(err) {
    var self = this;

    var req = self.ops.getOutReq(err.originalId);

    if (req && req.res) {
        req.res.errorEvent.emit(req.res, err);
    } else {
        // Only popOutReq if there is no call response object yet
        req = self.ops.popOutReq(err.originalId, {
            err: err,
            id: err.originalId,
            info: 'got error frame for unknown id'
        });
        if (!req) {
            return;
        }

        req.errorEvent.emit(req, err);
    }
};

TChannelConnection.prototype.start = function start() {
    var self = this;
    if (self.direction === 'out') {
        self.handler.sendInitRequest();
        self.handler.initResponseEvent.on(onOutIdentified);
    } else {
        self.handler.initRequestEvent.on(onInIdentified);
    }

    function onOutIdentified(init) {
        self.onOutIdentified(init);
    }

    function onInIdentified(init) {
        self.onInIdentified(init);
    }
};

TChannelConnection.prototype.onOutIdentified = function onOutIdentified(init) {
    var self = this;
    self.remoteName = init.hostPort;
    self.identifiedEvent.emit(self, {
        hostPort: init.hostPort,
        processName: init.processName
    });
};

TChannelConnection.prototype.onInIdentified = function onInIdentified(init) {
    var self = this;
    if (init.hostPort === '0.0.0.0:0') {
        self.remoteName = '' + self.socket.remoteAddress + ':' + self.socket.remotePort;
        assert(self.remoteName !== self.channel.hostPort,
              'should not be able to receive ephemeral connection from self');
    } else {
        self.remoteName = init.hostPort;
    }

    self.channel.peers.add(self.remoteName).addConnection(self);
    self.identifiedEvent.emit(self, {
        hostPort: self.remoteName,
        processName: init.processName
    });
};

TChannelConnection.prototype.close = function close(callback) {
    var self = this;
    if (self.socket.destroyed) {
        callback();
    } else {
        self.socket.once('close', callback);
        self.resetAll(errors.LocalSocketCloseError());
        self.socket.destroy();
    }
};

TChannelConnection.prototype.onSocketError = function onSocketError(err) {
    var self = this;
    if (!self.closing) {
        self.resetAll(errors.SocketError(err, {
            hostPort: self.channel.hostPort,
            direction: self.direction,
            remoteAddr: self.remoteAddr
        }));
    }
};

TChannelConnection.prototype.buildOutRequest = function buildOutRequest(options) {
    var self = this;
    options.logger = self.logger;
    options.random = self.random;
    options.timers = self.timers;
    return self.handler.buildOutRequest(options);
};

TChannelConnection.prototype.buildOutResponse = function buildOutResponse(req, options) {
    var self = this;
    var opts = {
        logger: self.logger,
        random: self.random,
        timers: self.timers
    };
    if (options) {
        // jshint forin:false
        for (var prop in options) {
            opts[prop] = options[prop];
        }
        // jshint forin:true
    }
    return self.handler.buildOutResponse(req, opts);
};

module.exports = TChannelConnection;
