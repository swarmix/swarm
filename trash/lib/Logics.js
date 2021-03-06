'use strict';

var env = require('./env');
var Spec = require('./Spec');
var Op = require('./Op');
var Syncable = require('./Syncable');

/**
 * A (full) Swarm peer is Storage+Host+Logics. Logics is the world
 * of actual Syncable CRDT objects of various types.
 */
function Logics (host) {
    this.id = '0+'+host.id;
    this.host = host;
    this.syncables = {};
    this.inner_states = {};
}
module.exports = Logics;

// An innner state getter; needs /type#id spec for the object.
Logics.prototype.getInnerState = function (obj) {
    if (obj._owner!==this) {
        throw new Error('an alien object');
    }
    return this.inner_states[obj.spec().toString()];
};

// Applies a serialized operation (or a batch thereof) to this replica
Logics.prototype.deliver = function (op) {

    var spec = op.spec.filter('/#').toString();
    var syncable = this.syncables[spec];
    if (!syncable) {
        console.warn('syncable not open', ''+spec, ''+op);
        return;
    }
    var events = [], self = this;

    switch (op.op()) {
    // handshake cycle pseudo ops
    case 'on':    break;
    case 'off':   break;
    case 'error':
        // As all the event/operation processing is asynchronous, we
        // cannot simply throw/catch exceptions over the network.
        // This method allows to send errors back asynchronously.
        // Sort of an asynchronous complaint mailbox :)
        console.error('something failed:', ''+op.spec, op.value);
    break;
    case 'diff':
        // Note that events are emitted *after* the complete diff is processed.
        var ops = op.unbundle();  // <<<<< FIXME state
        ops.forEach(function(op) {
            events.push (self.deliverOp(op));
        });
    break;
    default: // actual ops
        var e = this.deliverOp(op);
        e && events.push(e);
    }

    var inner = this.inner_states[op.spec.filter('/#')];
    inner && syncable.rebuild(inner);

    syncable.emit(events);

    // TODO merged ops, like
    //      !time+src.in text
    // should have their *last* stamp in the spec
    // TODO reactions (Syncable? Inner? here?)

    return op.spec;
};

//
Logics.prototype.deliverOp = function (op) {

    env.logs.logix && console.log('#'+op.id()+
        (env.multihost?'@'+this.id:''),
        op.spec.toString(), op.value);

    // sanity checks
    if (op.spec.pattern() !== '/#!.') {
        throw new Error('malformed spec: '+op.spec);
    }

    var events = [];
    var inner = this.inner_states[op.spec.filter('/#')];
    if (!inner) { // our syncable is stateless at the moment
        if (op.op()!=='state') {
            throw new Error('no state received yet; can not apply ops');
        }
        var fn = Syncable.types[op.spec.type()];
        if (!fn) {
            throw new Error('type unknown');
        }
        inner = new fn.Inner(op);
        this.inner_states[op.spec.filter('/#')] = inner;
        events.push({
            name: "init",
            value: op.value,
            target: null,
            old_version: '',
            spec: op.spec
        });
    }
    if (!this.acl(op)) {
        throw new Error('access violation: '+op.spec);
    }

    try {
        var e = inner.deliver(op);
        e && events.push(e);
    } catch (ex) {
        // TODO send back an .error
        return undefined;
    }

    return events;
};

// The method must decide whether the source of the operation has
// the rights to perform it. The method may check both the nearest
// source and the original author of the op.
// If this method ever mentions 'this', that is a really bad sign.
// @returns {boolean}
Logics.prototype.acl = function (op) {
    return true;
};

Logics.prototype.time = function () {
    return this.host.time();
};

// Inner state lifecycle:
// * unknown (outer: default, '')
// * created fresh: construcor, sent
// * arrived : parse, create, rebuild()
// SCHEME
/**
 * Register a syncable object.
 */

// Incorporate a syncable into this replica.
// In case the object is newly created (like `new Model()`), Logics
// assigns an id and saves it. For a known-id objects
// (like `new Model('2THjz01+gritzko~cA4')`) the state is queried
// from the storage/uplink. Till the state is received, the object
// is stateless (`obj.version()===undefined && !obj.hasState()`)
Logics.prototype.linkSyncable = function (obj) {
    var id = obj._id;
    if (!id) { // it is a new object; let's add it to the system
        var new_id = this.time();
        obj._id = id = new_id;
        // the default (zero) state is the same for all objects of the type
        // so the version id is the same too: !0
        var ev_spec = obj.spec().add('!0').add('.state');
        // for newly created objects, the 0 state is pushed ahead of the
        // handshake as the uplink certainly has nothing
        var state_op = new Op(ev_spec, '', this.id);
        this.host.storage.deliver(state_op);
        // TODO state push @host
        this.inner_states[obj.spec()] = new obj.constructor.Inner(state_op, this);
    }
    var spec = obj.spec().toString();
    if (spec in this.syncables) {
        return this.syncables[spec]; // there is such an object already
    }
    this.syncables[spec] = obj;  // OK, remember it
    obj._owner = this;
    if (new_id) {
        // if the user has supplied any initialization values, those must
        // be applied in the constructors; so it's the time to save it
        obj.save();
    } else {
        // simply init all the fields to defaults
        // inner state is certainly not available at this point
        obj.rebuild(null);
        // we'll repeat rebuild() on state arrival
    }

    // Unified local and remote subscriptions:
    //   !0 fictive subscription (like we are root, but send a preon)
    //   !0+myself subscription by the local logix ("zero pipe")
    //   !time+peer incoming (downstream) pipe subscription
    //   !time+myself outgoing (upstream) subscription
    var on_spec = obj.spec().add(this.id,'!').add('.on');
    var on = new Op (on_spec, obj._version || '', this.id);
    this.host.deliver(on);
    return obj;
};

Logics.prototype.unlinkSyncable = function (obj) {
    var id = obj._id;
    if (id in this.syncables) {
        if (this.syncables[id]!==obj) {
            throw new Error('the registered object is different');
        }
        delete this.syncables[id];
        var off_spec = obj.spec().add('!0').add('.off');
        this.host.deliver(new Op(off_spec, '', this.id));
    }
};

/** new Type()  in multihost env it may be safer to use Host.get() or,
  * at least, new Type(id, host) / new Type(somevalue, host) */
Logics.prototype.get = function (spec, callback) {
    if (spec && spec.constructor === Function && spec.prototype._type) {
        spec = '/' + spec.prototype._type;
    }
    spec = new Spec(spec);
    var typeid = spec.filter('/#');
    if (!typeid.has('/')) {
        throw new Error('typeless spec');
    }
    var o = typeid.has('#') && this.syncables[typeid];
    if (!o) {
        var t = Syncable.types[spec.type()];
        if (!t) {
            throw new Error('type unknown: ' + spec);
        }
        return new t(spec.id(), this.host);
    }
    return o;
};

// author a new operation
Logics.prototype.submit = function (syncable, op_name, value) { // TODO sig
    if (syncable._owner!==this) {
        throw new Error('alien op submission');
    }
    var spec = syncable.spec().add(this.host.time(), '!').add(op_name,'.');
    var op = new Op(spec, value, this.id);
    if (this.deliver(op)) {
        this.host.deliver(op, this);
    }
};

Logics.prototype.create = function (spec) {
    var type = new Spec(spec, '/').type();
    var type_constructor = Syncable.types[type];
    if (!type_constructor) {
        throw new Error('type unknown: ' + spec);
    }
    var stamp = this.time();
    var state = new Spec(type, '/').add(stamp, '#').add('!0.state');
    var op = new Op(state, '', this.id);
    var inner = new type_constructor.Inner(op);
    this.inner_states[op.spec.filter('/#')] = inner;
    this.host.deliver(op, this);
    return new type_constructor(stamp, this);
};
