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
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;

var errors = require('./errors');
var OutArgStream = require('./argstream').OutArgStream;

var States = Object.create(null);
States.Initial = 0;
States.Streaming = 1;
States.Done = 2;
States.Error = 3;

function TChannelOutgoingResponse(id, options) {
    options = options || {};
    assert(options.sendFrame, 'required option sendFrame');
    var self = this;
    EventEmitter.call(self);
    self.logger = options.logger;
    self.random = options.random;
    self.timers = options.timers;

    self.start = 0;
    self.end = 0;
    self.state = States.Initial;
    self.id = id || 0;
    self.code = options.code || 0;
    self.tracing = options.tracing || null;
    self.headers = options.headers || {};
    self.checksumType = options.checksumType || 0;
    self.checksum = options.checksum || null;
    self.ok = self.code === 0;
    self.sendFrame = options.sendFrame;
    self.span = options.span || null;
    if (options.streamed) {
        self.streamed = true;
        self._argstream = OutArgStream();
        self.arg1 = self._argstream.arg1;
        self.arg2 = self._argstream.arg2;
        self.arg3 = self._argstream.arg3;
        self._argstream.on('error', function passError(err) {
            self.emit('error', err);
        });
        self._argstream.on('frame', function onFrame(parts, isLast) {
            self.sendParts(parts, isLast);
        });
        self._argstream.on('finish', function onFinish() {
            self.emit('finish');
        });
    } else {
        self.streamed = false;
        self._argstream = null;
        self.arg1 = null;
        self.arg2 = null;
        self.arg3 = null;
    }

    self.on('finish', self.onFinish);
}

inherits(TChannelOutgoingResponse, EventEmitter);

TChannelOutgoingResponse.prototype.onFinish = function onFinish() {
    var self = this;
    if (!self.end) self.end = self.timers.now();
    if (self.span) {
        self.emit('span', self.span);
    }
};

TChannelOutgoingResponse.prototype.type = 'tchannel.outgoing-response';

TChannelOutgoingResponse.prototype.sendParts = function sendParts(parts, isLast) {
    var self = this;
    switch (self.state) {
        case States.Initial:
            self.sendCallResponseFrame(parts, isLast);
            break;
        case States.Streaming:
            self.sendCallResponseContFrame(parts, isLast);
            break;
        case States.Done:
            self.emit('error', errors.ResponseFrameState({
                attempted: 'arg parts',
                state: 'Done'
            }));
            break;
        case States.Error:
            // TODO: log warn
            break;
    }
};

TChannelOutgoingResponse.prototype.sendCallResponseFrame = function sendCallResponseFrame(args, isLast) {
    var self = this;
    switch (self.state) {
        case States.Initial:
            self.start = self.timers.now();
            self.sendFrame.callResponse(args, isLast);
            if (self.span) {
                self.span.annotate('ss');
            }
            if (isLast) self.state = States.Done;
            else self.state = States.Streaming;
            break;
        case States.Streaming:
            self.emit('error', errors.ResponseFrameState({
                attempted: 'call response',
                state: 'Streaming'
            }));
            break;
        case States.Done:
        case States.Error:
            self.emit('error', errors.ResponseAlreadyDone({
                attempted: 'call response'
            }));
    }
};

TChannelOutgoingResponse.prototype.sendCallResponseContFrame = function sendCallResponseContFrame(args, isLast) {
    var self = this;
    switch (self.state) {
        case States.Initial:
            self.emit('error', errors.ResponseFrameState({
                attempted: 'call response continuation',
                state: 'Initial'
            }));
            break;
        case States.Streaming:
            self.sendFrame.callResponseCont(args, isLast);
            if (isLast) self.state = States.Done;
            break;
        case States.Done:
        case States.Error:
            self.emit('error', errors.ResponseAlreadyDone({
                attempted: 'call response continuation'
            }));
    }
};

TChannelOutgoingResponse.prototype.sendError = function sendError(codeString, message) {
    var self = this;
    if (self.state === States.Done || self.state === States.Error) {
        self.emit('error', errors.ResponseAlreadyDone({
            attempted: 'send error frame: ' + codeString + ': ' + message
        }));
    } else {
        if (self.span) {
            self.span.annotate('ss');
        }
        self.state = States.Error;
        if (self.streamed) {
            // TODO: we could decide to flush any parts in a (first?) call res frame
            self._argstream.finished = true;
            self.arg1.end();
            self.arg2.end();
            self.arg3.end();
        }
        self.sendFrame.error(codeString, message);
        self.emit('errored', codeString, message);
        self.emit('finish');
    }
};

TChannelOutgoingResponse.prototype.setOk = function setOk(ok) {
    var self = this;
    if (self.state !== States.Initial) {
        self.emit('error', errors.ResponseAlreadyStarted({
            state: self.state
        }));

    }
    self.ok = ok;
    self.code = ok ? 0 : 1; // TODO: too coupled to v2 specifics?
    if (self.streamed) {
        self.arg1.end();
    }
};

TChannelOutgoingResponse.prototype.sendOk = function sendOk(res1, res2) {
    var self = this;
    self.setOk(true);
    self.send(res1, res2);
};

TChannelOutgoingResponse.prototype.sendNotOk = function sendNotOk(res1, res2) {
    var self = this;
    if (self.state === States.Error) {
        self.logger.error('cannot send application error, already sent error frame', {
            res1: res1,
            res2: res2
        });
    } else {
        self.setOk(false);
        self.send(res1, res2);
    }
};

TChannelOutgoingResponse.prototype.send = function send(res1, res2) {
    var self = this;
    if (self.streamed) {
        self.arg2.end(res1);
        self.arg3.end(res2);
    } else {
        self.sendCallResponseFrame([self.arg1, res1, res2], true);
        self.emit('finish');
    }
};

TChannelOutgoingResponse.States = States;

module.exports = TChannelOutgoingResponse;