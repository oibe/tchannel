# Intro

All example code is done against the node implementation, however none of the
concepts should be node-specific.

All settings described below can be set at a per-channel level or a per-request
level.

All defaults described are defined as "unless set at the channel or request
level".

# What Hosts

```
var chan = TChannel();

// use any host
chan.request();

// use these hosts
chan.request({
    hosts: ['1.2.3.4:567', '2.3.4.5:678']
});

// use this hosts
chan.request({
    host: '1.2.3.4:567' // implemented as sugar for hosts: ['1.2.3.4:567']
});
```

The `host` option is an exception: it cannot be specified at the channel level
and serves only as a convenience and compatibility path at the request level.
However the hosts `option` can be specified at channel level.


## Sub Channels

AKA why it makes sense to specify hosts as a channel option.

```
var subchan = chan.subChannel({
    hosts: ['1.2.3.4:567', '2.3.4.5:678']
});

// consumer can ochestrate peer sharding:
subchan.peers.remove('2.3.4.5:6789');
subchan.peers.add('3.4.5.6:789', chan.peers.get('3.4.5.6:789'));
```

Proposal for `.subChannel` semantics:
- hosts is required (maybe make it positional?)
- no automatic adding is provided, adding any new peers is wholly up to the
  consumer
- conversely, removal is linked such that removal on `chan` removes on all
  `subchan`s
- TBD whether adding a peer to a `subchan` that is not on its parent `chan`:
  - is an error
  - just adds it to the parent `chan` too
  - just adds it to the `subchan` only (consumer gets to deal with their choices)

TBD what the coupling between parent and sub channel will be:
- on the one hand, the above semantics can be achieved with a loose
  event-emitter/observer relationship alone
- on the other hand, keeping parent <-> sub channel relations allows
  - introspection
  - service dispatch handling from the parent

Immediate plans are to chase #127:

### Explicate the anonymous `peers` object

Current shape is:
- data structure: `peers :: Map<hostPort, List<TChannelConnection>>`
- with method beside: `setPeer :: (hostPort, TChannelConnection) -> TChannelConnection`
- with method beside: `getPeer :: (hostPort) -> TChannelConnection`
- with method beside: `removePeer :: (hostPort, TChannelConnection) -> void`

Proposed new shape is:
```
peers      :: {
    set    :: (hostPort, TChannelConnection) -> TChannelPeer
    get    :: (hostPort) -> TChannelPeer
    remove :: (hostPort) -> void
}

TChannelPeer         :: {
    hostPort         :: String // "host:port"
    isEphemeral      :: Boolean
    inPending        :: Number
    outPending       :: Number
    request          :: (options) -> TChannelOutgoingRequest
    addConnection    :: (TChannelConnection) -> void
    removeConnection :: (TChannelConnection) -> void
}
```

The `TChannelConnection <-> TChannel` relationship will change to be
`TChannelConnection <-> TChannelPeer <-> TChannel`:
- identified events will be emitted on the peer, not the channel; if useful we
  can provide a `peerIdentified` event at channel level
- connection close events will now be observed by the peer object
- non-ephemeral peers will not persist on the channel object
- ephemeral peer cleanup will happen between peer and channel objects

### Restore peer life cycle bound

Once we make peers persist on channels, we'll need to provide for cleaning then
up eventually.

# Service Option

Especially for use in conjunction with sub channels, we'll add a `service`
option at the channel level (it already exists at the request level).

This option will serve as a default for sending request.

If we decide to keep references between parent and sub channels, then we could
also choose to provide service dispatch based on this option.

# Re-Tries

Retries will be driven by a `trys` count option that defaults to 1.

```
var chan = TChannel();

// off by default
chan.request();

// opt-in
chan.request({
    trys: 3
});

// can provide per-channel defaults
var chan = TChannel({
    trys: 3
});

// opt-out
chan.request({
    trys: 1
});
```

## Re-try Where?

```
selectRetryHost :: (chan, op) -> hostPort
```

Default selection function initially will be random.

Beyond that we need to provide more data to drive other host selection
strategies, such as:
- peer data
  - number of outstanding operations
  - response time-series data and/or statistics
  - error time-series data and/or statistics
- op data
  - what hostPorts has this operation been attempted on...
  - ...with what results (if any)
  - pivot req to be reqs plurality

# Se-Tries

Speculative/backup requests will be driven by a `speculate` option that
defaults to 0.  This value indicates how many extra attempts (above the
necessary first) should be done initially.

```
var chan = TChannel();

// off by default
chan.request();

// opt-in
chan.request({
    speculate: 1
});

// can provide per-channel defaults
var chan = TChannel({
    speculate: 1
});

// opt-out
chan.request({
    speculate: 0
});
```

## Se-try Where?

```
selectSetryHost :: (chan, op) -> hostPort
```

Default selection function initially will be random, same notes apply as for retries.

## Interaction With Retries

Primarily there are two categories of strategies:
- retry on all failed
- retry on any failed

Both cases have choices in how to limit total number of tries:
- `speculate x trys` in total
  - either by saying "each retry gets speculated"
  - or "each speculation gets retried"
- `trys` in total

Initially we'll be taking the simplest solution from both categories:
- retry on all failed
- re tries in total

These choices are deemed "simplest" because:

- retrying mid speculation raises concerns about needing claim notification
  back to the originating entity, which may not even have a listening port;
  this is likely solvable by using streaming support to always send arg1 + code
  asap and take that as a "start of work" claim client side... but needs more
  consideration
- doing more than the given `trys` seems "wrong" on its face, and at any rate
  isn't as easy to reason about