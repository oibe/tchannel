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

"use strict";

var States = require('./states');
var StateMachine = require('./state_machine');

// The each circuit uses the circuits collection as the "nextHandler" for
// "shouldRequest" to consult.  Peers use this hook to weight peers both by
// healthy and other factors, but the circuit only needs to know about health
// before forwarding.

function AlwaysShouldRequestHandler() { }

AlwaysShouldRequestHandler.prototype.shouldRequest = function shouldRequest() {
    return true;
};

var alwaysShouldRequestHandler = new AlwaysShouldRequestHandler();

function Circuits(options) {
    var self = this;
    self.circuits = {};
    self.circuitsByServiceName = {};
    self.stateOptions = {
        stateMachine: self,
        nextHandler: alwaysShouldRequestHandler,
        timers: options.timers,
        random: options.random,
        period: options.period,
        maxErrorRate: options.maxErrorRate,
        minRequests: options.minRequests,
        probation: options.probation,
    };
    self.shouldRequestOptions = {};
}

Circuits.prototype.getCircuit = function getCircuit(callerName, serviceName, endpointName) {
    var self = this;
    // TODO escape components
    var circuitName = callerName + '::' + serviceName + '::' + endpointName;
    var circuit = self.circuits[circuitName];
    if (!circuit) {
        circuit = new Circuit();
        circuit.circuitName = circuitName;
        circuit.callerName = callerName;
        circuit.serviceName = serviceName;
        circuit.endpointName = endpointName;
        circuit.shouldRequestOptions = self.shouldRequestOptions;
        circuit.stateOptions = self.stateOptions;
        self.circuits[circuitName] = circuit;
    }
    return circuit;
};

Circuits.prototype.handleRequest = function handleRequest(req, buildRes, nextHandler) {
    var self = this;
    var callerName = req.headers.cn;
    if (!callerName) {
        return buildRes().sendError('BadRequest', 'All requests must have the cn (caller service name) header');
    }
    var serviceName = req.serviceName;
    if (!serviceName) {
        return buildRes().sendError('BadRequest', 'All requests must have a service name');
    }
    return req.withArg1(function withArg1(endpointName) {
        var circuit = self.getCircuit(callerName, serviceName, endpointName);
        return circuit.handleRequest(req, buildRes, nextHandler);
    });
};

// Called upon membership change to collect services that the corresponding
// egress node is no longer responsible for.
Circuits.prototype.updateServices = function updateServices(serviceNames) {
    var self = this;
    var selfServiceNames = Object.keys(self.circuitsByServiceName);
    for (var index = 0; index < selfServiceNames.length; index++) {
        var selfServiceName = self.circuitsByServiceName[index];
        if (serviceNames.indexOf(selfServiceNames) < 0) {
            self.collectService(selfServiceName);
        }
    }
};

Circuits.prototype.collectService = function collectService(serviceName) {
    var self = this;
    var circuits = self.circuitsByServiceName[serviceName];
    for (var index = 0; index < circuits.length; index++) {
        delete self.circuits[circuits[index].circuitName];
    }
};

function Circuit() {
    var self = this;
    self.circuitName = null;
    self.callerName = null;
    self.serviceName = null;
    self.endpointName = null;
    self.shouldRequestOptions = null;
    self.stateOptions = null;
    StateMachine.call(self);
    self.setState(States.HealthyState);
}

Circuit.prototype.handleRequest = function handleRequest(req, buildRes, nextHandler) {
    var self = this;
    if (self.state.shouldRequest(req, self.shouldRequestOptions)) {
        return self.monitorRequest(req, buildRes, nextHandler);
    } else {
        return buildRes().sendError('Declined', 'Service is not healthy');
    }
};

Circuit.prototype.monitorRequest = function monitorRequest(req, buildRes, nextHandler) {
    var self = this;
    self.state.onRequest(req);

    function monitorBuildRes(options) {
        var res = buildRes(options);
        res.errorEvent.on(onResponseError);
        res.finishEvent.on(onResponseFinish);
        return res;
    }

    function onResponseError(err) {
        self.state.onRequestError(err);
    }

    function onResponseFinish() {
        self.state.onRequestResponse(req);
    }

    return nextHandler.handleRequest(req, monitorBuildRes);
};

module.exports = Circuits;
