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

var inherits = require('util').inherits;

var TChannelPeer = require('./peer');
var TChannelSelfConnection = require('./self_connection');

function TChannelSelfPeer(channel) {
    if (!(this instanceof TChannelSelfPeer)) {
        return new TChannelSelfPeer(channel);
    }
    var self = this;
    TChannelPeer.call(self, channel, channel.hostPort);
}
inherits(TChannelSelfPeer, TChannelPeer);

TChannelSelfPeer.prototype.connect = function connect() {
    var self = this;
    while (self.connections[0] &&
           self.connections[0].closing) {
        self.connections.shift();
    }
    var conn = self.connections[0];
    if (!conn) {
        conn = TChannelSelfConnection(self.channel);
        self.addConnection(conn);
    }
    return conn;
};

TChannelSelfPeer.prototype.makeOutSocket = function makeOutSocket() {
    throw new Error('refusing to make self out socket');
};

TChannelSelfPeer.prototype.makeOutConnection = function makeOutConnection(/* socket */) {
    throw new Error('refusing to make self out connection');
};

module.exports = TChannelSelfPeer;