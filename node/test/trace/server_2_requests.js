// Copyright (c) 2015 Uber Technologies, Inc.

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

var CountedReadySignal = require('ready-signal/counted');
var DebugLogtron = require('debug-logtron');
var test = require('tape');

var TChannel = require('../../channel.js');

var logger = DebugLogtron('tchannel');

var fixture = require('./server_2_requests_fixture');
var validators = require('../lib/simple_validators');

test('basic tracing test', function (assert) {

    var spans = [];

    function traceReporter(span) {
        spans.push(span);
        logger.debug(span.toString());
    }

    var subservice = new TChannel({
        logger: logger,
        traceReporter: traceReporter,
        trace: true
    });
    var subChan = subservice.makeSubChannel({
        serviceName: 'subservice'
    });

    var server = new TChannel({
        logger: logger,
        traceReporter: traceReporter,
        trace: true
    });
    var serverChan = server.makeSubChannel({
        serviceName: 'server'
    });

    var client = new TChannel({
        logger: logger,
        traceReporter: traceReporter,
        trace: true
    });
    var clientChan = client.makeSubChannel({
        serviceName: 'server'
    });

    subChan.register('/foobar', function (req, res) {
        logger.debug("subserv sr");
        res.sendOk('result', 'success');
    });

    subChan.register('/barbaz', function (req, res) {
        logger.debug("subserv 2 sr");
        res.sendOk('result', 'success');
    });

    // normal response
    serverChan.register('/top_level_endpoint', function (req, res) {
        logger.debug("top level sending to subservice");
        var serverRequestsDone = CountedReadySignal(2);

        setTimeout(function () {
            serverChan
                .request({
                    host: '127.0.0.1:4042',
                    serviceName: 'subservice',
                    parent: req,
                    trace: true
                }).send('/foobar', 'arg1', 'arg2', function (err, subRes) {
                    logger.debug("top level recv from subservice: " + subRes);
                    if (err) return res.sendOk('error', err);

                    serverRequestsDone.signal();
                });
        }, 40);

        process.nextTick(function () {
            var servReq = serverChan.request({
                host: '127.0.0.1:4042',
                serviceName: 'subservice',
                parent: req,
                trace: true});
            var peers = server.peers.values();
            var ready = new CountedReadySignal(peers.length);
            peers.forEach(function each(peer) {
                if (peer.isConnected()) {
                    ready.signal();
                } else {
                    peer.connect().on('identified', ready.signal);
                }
            });
            ready(function send() {
                servReq.send('/barbaz', 'arg1', 'arg2', function (err, subRes) {
                    logger.debug("top level recv from subservice: " + subRes);
                    if (err) return res.sendOk('error', err);

                    serverRequestsDone.signal();
                });
            });
        });

        serverRequestsDone(function () {
            res.sendOk('result', 'success');
        });

    });

    var ready = CountedReadySignal(3);
    var requestsDone = CountedReadySignal(1);

    ready(function (err) {
        if (err) {
            throw err;
        }

        logger.debug('client making req');
        var req = clientChan.request({
            host: '127.0.0.1:4040',
            serviceName: 'server',
            trace: true,
            hasNoParent: true
        });
        var peers = client.peers.values();
        var ready = new CountedReadySignal(peers.length);
        peers.forEach(function each(peer) {
            peer.connect().on('identified', ready.signal);
        });
        ready(function send() {
            req.send('/top_level_endpoint', "arg 1", "arg 2", function (err, res) {
                    logger.debug("client recv from top level: " + res);
                    requestsDone.signal();
                });
        });
    });

    server.listen(4040, '127.0.0.1', ready.signal);
    client.listen(4041, '127.0.0.1', ready.signal);
    subservice.listen(4042, '127.0.0.1', ready.signal);

    requestsDone(function () {
        setTimeout(function () {
            var cleanspans = spans.map(function (item) {
                return item.toJSON();
            });

            validators.validateSpans(assert, cleanspans, fixture);

            assert.end();
            client.close();
            server.close();
            subservice.close();
        }, 10);
    });
});
