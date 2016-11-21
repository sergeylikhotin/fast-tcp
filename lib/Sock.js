'use strict';

var Readable = require('stream').Readable;
var net = require('net');
var util = require('util');
var EventEmitter = require('events');
var ut = require('utjs');

var Serializer = require('./Serializer');
var Reader = require('./Reader');
var Constants = require('./Constants');

var MAX_MESSAGE_ID = Math.pow(2, 32) - 1;

/**
 * The super class of Socket.
 *
 * @constructor
 * @abstract
 * @fires Sock#reconnecting
 * @fires Sock#socket_connect
 * @fires Sock#end
 * @fires Sock#close
 * @fires Sock#error
 */
function Sock(serializer, opts) {
  opts = ut.isObject(opts) ? opts : {};
  Sock.super_.call(this);

  this._serializer = serializer;
  this._reader = new Reader();
  this._opts = opts;

  this._shouldReconnect = ut.isBoolean(opts.reconnect) ? opts.reconnect : Constants.RECONNECT;

  this._reconnectInterval = ut.isNumber(opts.reconnectInterval) ? opts.reconnectInterval :
      Constants.RECONNECT_INTERVAL;

  this._autoConnect = ut.isBoolean(opts.autoConnect) ? opts.autoConnect : Constants.AUTO_CONNECT;

  this._useQueue = ut.isBoolean(opts.useQueue) ? opts.useQueue : Constants.USE_QUEUE;

  this._queueSize = ut.isNumber(opts.queueSize) ? opts.queueSize : Constants.QUEUE_SIZE;

  this._timeout = ut.isNumber(opts.timeout) ? opts.timeout : Constants.TIMEOUT;

  this._messageListener = ut.isFunction(opts.messageListener) ? opts.messageListener : null;

  /**
   * A unique identificator for this socket.
   * @type {String}
   */
  this.id = null;

  this._messageId = 1;
  this._acks = {};

  this._socket = null;
  this._connected = false;
  this._manuallyClosed = false;

  this._queue = [];

  this._streams = {};

  if (this._autoConnect) {
    this.connect();
  }
}

util.inherits(Sock, EventEmitter);

Sock.prototype._superEmit = Sock.prototype.emit;

/**
 * Send a FIN packet.
 */
Sock.prototype.end = function () {
  if (this._connected) {
    this._manuallyClosed = true;
    this._socket.end();
  }
};

/**
 * Close the socket.
 */
Sock.prototype.destroy = function () {
  if (this._connected) {
    this._manuallyClosed = true;
    this._socket.destroy();
  }
};

/**
 * Connect the socket. The socket will be connected automatically by default
 * so this method is only useful when you use otps.autoConnect: false,
 * in the constructor.
 */
Sock.prototype.connect = function () {
  if (!this._connected) {
    this._manuallyClosed = false;
    this._socket = net.createConnection(this._opts)
        .setTimeout(this._timeout);
    this._bindEvents();
  }
};

/**
 * Get the version of the underlying serializer.
 * @return {Number} The serializer version.
 */
Sock.prototype.getVersion = function () {
  return Serializer.VERSION;
};

Sock.prototype._send = function (event, data, mt, opts) {
  opts = opts !== undefined ? opts : {};
  var messageId = opts.messageId !== undefined ? opts.messageId : this._nextMessageId();
  var cb = opts.cb !== undefined ? opts.cb : null;

  if (cb !== null) {
    this._acks[messageId] = cb;
  }

  var buff = this._serializer.serialize(event, data, mt, messageId);

  if (this._connected) {
    return this._socket.write(buff);
  } else if (this._useQueue) {
    if (this._queue.length + 1 > this._queueSize) {
      this._queue.shift();
    }

    this._queue.push(buff);
    return false;
  }
};

Sock.prototype._reconnect = function () {
  var _this = this;
  setTimeout(function () {
    /**
     * The socket is trying to reconnect.
     *
     * @event Sock#reconnecting
     */
    _this._superEmit('reconnecting');
    _this.connect();
  }, this._reconnectInterval);
};

Sock.prototype._bindEvents = function () {
  var _this = this;

  this._socket.on('connect', function () {
    _this._connected = true;
    _this._flushQueue();

    // Resume all waiting streams
    _this._socket.emit('drain');

    /**
     * Connected underlying net.Socket, all messages in queue will
     * be sent and new messages will be sent directly.
     *
     * @event Sock#socket_connect
     */
    _this._superEmit('socket_connect');
  });

  this._socket.on('data', function (chunk) {
    var buffers = _this._reader.read(chunk);
    var buffersLength = buffers.length;
    var i;

    for (i = 0; i < buffersLength; i++) {
      _this._onMessage(_this._serializer.deserialize(buffers[i]));
    }
  });

  this._socket.on('end', function () {
    /**
     * End event from net.Socket.
     *
     * @event Sock#end
     */
    _this._superEmit('end');
  });

  this._socket.on('close', function (isError) {
    _this._connected = false;
    if (_this._shouldReconnect && !_this._manuallyClosed) {
      _this._reconnect();
    }

    /**
     * Close event from net.Socket.
     *
     * @event Sock#close
     */
    _this._superEmit('close');
  });

  this._socket.on('error', function (err) {
    /**
     * Error event from net.Socket.
     *
     * @event Sock#error
     */
    _this._superEmit('error', err);
  });

  this._socket.on('timeout', function () {
    _this._socket.destroy();

    /**
     * TIMEOUT error event.
     *
     * @event Sock#error
     */
    _this._superEmit('error', new Error('connect TIMEOUT ' +
        _this._opts.host + ':' + _this._opts.port));
  });
};

Sock.prototype._onMessage = function (msg) {
  switch (msg.mt) {
    case Serializer.MT_DATA:
      this._superEmit(msg.event, msg.data);
      break;
    case Serializer.MT_DATA_STREAM_OPEN:
      this._openDataStream(msg);
      break;
    case Serializer.MT_DATA_STREAM:
      this._transmitDataStream(msg);
      break;
    case Serializer.MT_DATA_STREAM_CLOSE:
      this._closeDataStream(msg);
      break;
    case Serializer.MT_DATA_WITH_ACK:
      this._superEmit(msg.event, msg.data, this._ackCallback(msg.messageId));
      break;
    case Serializer.MT_ACK:
      this._acks[msg.messageId](msg.data);
      delete this._acks[msg.messageId];
      break;
    default:
      if (this._messageListener) {
        this._messageListener(msg);
      }
  }
};

Sock.prototype._openDataStream = function (msg) {
  var _this = this;
  var readStream = new Readable({
    read: function (size) {
      if (_this._socket.isPaused()) {
        _this._socket.resume();
      }
    }
  });

  this._streams[msg.event] = readStream;
  this._superEmit(msg.event, msg.data, readStream);
};

Sock.prototype._transmitDataStream = function (msg) {
  var readStream = this._streams[msg.event];

  if (!readStream.push(msg.data)) {
    this._socket.pause();
  }
};

Sock.prototype._closeDataStream = function (msg) {
  var readStream = this._streams[msg.event];

  readStream.push(null);
  delete this._streams[msg.event];
};

Sock.prototype._ackCallback = function (messageId) {
  var _this = this;

  return function (data) {
    _this._send('', data, Serializer.MT_ACK, { messageId: messageId });
  };
};

Sock.prototype._nextMessageId = function () {
  if (++this._messageId > MAX_MESSAGE_ID) {
    this._messageId = 1;
  }

  return this._messageId;
};

Sock.prototype._flushQueue = function () {
  if (this._queue.length > 0) {
    for (var i = 0; i < this._queue.length; i++) {
      this._socket.write(this._queue[i]);
    }

    this._queue.length = 0;
  }
};

module.exports = Sock;