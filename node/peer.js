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
var inherits = require('util').inherits;
var EventEmitter = require('./lib/event_emitter');
var StateMachine = require('./state_machine');
var net = require('net');

var TChannelConnection = require('./connection');
var errors = require('./errors');
var states = require('./states');

function TChannelPeer(channel, hostPort, options) {
    if (!(this instanceof TChannelPeer)) {
        return new TChannelPeer(channel, hostPort, options);
    }
    var self = this;
    EventEmitter.call(self);
    StateMachine.call(self);
    self.stateChangedEvent = self.defineEvent('stateChanged');
    self.allocConnectionEvent = self.defineEvent('allocConnection');

    self.channel = channel;
    self.logger = self.channel.logger;
    self.options = options || {};
    self.hostPort = hostPort;
    self.isEphemeral = self.hostPort === '0.0.0.0:0';
    self.connections = [];
    self.random = self.channel.random;

    self.stateOptions = {
        timers: self.channel.timers,
        random: self.channel.random,
        period: self.options.period,
        maxErrorRate: self.options.maxErrorRate,
        minimumRequests: self.options.minimumRequests,
        probation: self.options.probation,
        stateMachine: self,
        nextHandler: self
    };

    if (self.options.initialState) {
        self.setState(self.options.initialState);
        delete self.options.initialState;
    } else {
        self.setState(states.HealthyState);
    }
}

inherits(TChannelPeer, EventEmitter);

TChannelPeer.prototype.isConnected = function isConnected(direction, identified) {
    var self = this;
    if (identified === undefined) identified = true;
    for (var i = 0; i < self.connections.length; i++) {
        var conn = self.connections[i];
        if (direction && conn.direction !== direction) {
            continue;
        } else if (conn.closing) {
            continue;
        } else if (conn.remoteName !== null || !identified) {
            return true;
        }
    }
    return false;
};

TChannelPeer.prototype.close = function close(callback) {
    var self = this;
    var counter = self.connections.length;
    if (counter) {
        self.connections.forEach(function eachConn(conn) {
            conn.close(onClose);
        });
    } else {
        self.state.close(callback);
    }
    function onClose() {
        if (--counter <= 0) {
            if (counter < 0) {
                self.logger.error('closed more peer sockets than expected', {
                    counter: counter
                });
            }
            self.state.close(callback);
        }
    }
};

TChannelPeer.prototype.setState = StateMachine.prototype.setState;

TChannelPeer.prototype.getInConnection = function getInConnection() {
    var self = this;
    for (var i = 0; i < self.connections.length; i++) {
        var conn = self.connections[i];
        if (!conn.closing) return conn;
    }
    return null;
};

TChannelPeer.prototype.getOutConnection = function getOutConnection() {
    var self = this;
    for (var i = self.connections.length - 1; i >= 0; i--) {
        var conn = self.connections[i];
        if (!conn.closing) return conn;
    }
    return null;
};

TChannelPeer.prototype.connect = function connect(outOnly) {
    var self = this;
    var conn = self.getOutConnection();
    if (!conn || (outOnly && conn.direction !== 'out')) {
        var socket = self.makeOutSocket();
        conn = self.makeOutConnection(socket);
        self.addConnection(conn);
    }
    return conn;
};

TChannelPeer.prototype.waitForIdentified =
function waitForIdentified(callback) {
    var self = this;

    var conn = self.connect();

    if (conn.closing) {
        onConnectionClose(conn.closeError);
    } else {
        conn.closeEvent.on(onConnectionClose);

        // conn.handler is a self peer detection
        if (!self.isConnected() && conn.handler) {
            conn.identifiedEvent.on(onIdentified);
            return;
        } else {
            onIdentified();
        }
    }

    function onConnectionClose(err) {
        conn.closeEvent.removeListener(onConnectionClose);
        callback(err || errors.TChannelConnectionCloseError());
    }

    function onIdentified() {
        conn.closeEvent.removeListener(onConnectionClose);
        callback(null);
    }
};

TChannelPeer.prototype.request = function peerRequest(options) {
    var self = this;
    var req = self.connect().request(options);

    self.state.onRequest(req);

    req.errorEvent.on(onError);
    req.responseEvent.on(onResponse);

    function onError(err) {
        self.state.onRequestError(err);
    }

    function onResponse(res) {
        self.state.onRequestResponse(req);
    }

    return req;
};

TChannelPeer.prototype.addConnection = function addConnection(conn) {
    var self = this;
    // TODO: first approx alert for self.connections.length > 2
    // TODO: second approx support pruning
    if (conn.direction === 'out') {
        self.connections.push(conn);
    } else {
        self.connections.unshift(conn);
    }
    conn.errorEvent.on(onConnectionError);
    conn.closeEvent.on(onConnectionClose);
    return conn;

    function onConnectionError(/* err */) {
        // TODO: log?
        self.removeConnection(conn);
    }

    function onConnectionClose() {
        self.removeConnection(conn);
    }
};

TChannelPeer.prototype.removeConnection = function removeConnection(conn) {
    var self = this;
    var list = self.connections;
    var index = list ? list.indexOf(conn) : -1;
    if (index !== -1) {
        return list.splice(index, 1)[0];
    } else {
        return null;
    }
};

TChannelPeer.prototype.makeOutSocket = function makeOutSocket() {
    var self = this;
    var parts = self.hostPort.split(':');
    assert(parts.length === 2, 'invalid destination');
    var host = parts[0];
    var port = parts[1];
    assert(host !== '0.0.0.0', 'cannot connect to ephemeral peer');
    assert(port !== '0', 'cannot connect to dynamic port');
    var socket = net.createConnection({host: host, port: port});
    return socket;
};

TChannelPeer.prototype.makeOutConnection = function makeOutConnection(socket) {
    var self = this;
    var chan = self.channel.topChannel || self.channel;
    var conn = new TChannelConnection(chan, socket, 'out', self.hostPort);
    self.allocConnectionEvent.emit(self, conn);
    return conn;
};

TChannelPeer.prototype.outPendingWeightedRandom = function outPendingWeightedRandom() {
    // A weighted random variable:
    //   random() ** (1 / weight)
    // Such that the probability distribution is uniform for weights of 0, but
    // an increasing bias with increasing weight.
    // However, although weight should start at 0 and increase probability,
    // the number of pending requests starts at 0 and should decrease
    // probability as it increases.
    // For 0 pending requests, we produce a uniform probability distribution by
    // raising a uniform random variable to the power of 1 (pending + 1).
    // As the number of pending requests increase, the magnitude of the power
    // increases and the probability distribution develops a bias toward zero.
    // TODO review weighted reservoir sampling:
    // http://arxiv.org/pdf/1012.0256.pdf
    var self = this;
    var pending = self.countOutPending();
    return Math.pow(self.random(), 1 + pending);
};

TChannelPeer.prototype.countOutPending = function countOutPending() {
    var self = this;
    var pending = 0;
    for (var index = 0; index < self.connections.length; index++) {
        var connPending = self.connections[index].ops.getPending();

        pending += connPending.out;
    }
    return pending;
};

// Consulted depending on the peer state
TChannelPeer.prototype.shouldRequest = function shouldRequest() {
    var self = this;
    // space:
    //   [0.1, 0.2)  unconnected peers
    //   [0.2, 0.3)  incoming connections
    //   [0.3, 0.4)  new outgoing connections
    //   [0.4, 1.0)  identified outgoing connections
    var inconn = self.getInConnection();
    var outconn = self.getOutConnection();
    var random = self.outPendingWeightedRandom();
    if (!inconn && !outconn) {
        return 0.1 + random * 0.1;
    } else if (!outconn || outconn.direction !== 'out') {
        self.connect();
        return 0.2 + random * 0.1;
    } else if (outconn.remoteName === null) {
        return 0.3 + random * 0.1;
    } else {
        return 0.4 + random * 0.6;
    }
};

module.exports = TChannelPeer;
