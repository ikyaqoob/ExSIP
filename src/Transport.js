/**
 * @fileoverview Transport
 */

/**
 * @augments ExSIP
 * @class Transport
 * @param {ExSIP.UA} ua
 * @param {Object} server ws_server Object
 */
(function(ExSIP) {
var Transport,
  logger = new ExSIP.Logger(ExSIP.name +' | '+ 'TRANSPORT'),
  C = {
    // Transport status codes
    STATUS_READY:        0,
    STATUS_DISCONNECTED: 1,
    STATUS_ERROR:        2
  };

Transport = function(ua, server) {
  this.ua = ua;
  this.ws = null;
  this.server = server;
  this.reconnection_attempts = 0;
  this.closed = false;
  this.connected = false;
  this.reconnectTimer = null;
  this.lastTransportError = {};

  this.ua.transport = this;

  // Connect
  this.connect();
};

Transport.prototype = {
  /**
   * Send a message.
   * @param {ExSIP.OutgoingRequest|String} msg
   * @returns {Boolean}
   */
  send: function(msg) {
    var message = msg.toString();

    if(this.ws && this.readyState() === WebSocket.OPEN) {
      logger.debug('sending WebSocket message:\n\n' + message + '\n', this.ua);
      this.ws.send(message);
      return true;
    } else {
      logger.warn('unable to send message, WebSocket is not open', this.ua);
      return false;
    }
  },

  readyState: function() {
    return this.ws.readyState;
  },

  /**
  * Disconnect socket.
  */
  disconnect: function() {
    if(this.ws) {
      this.closed = true;
      logger.log('closing WebSocket ' + this.server.ws_uri, this.ua);
      this.ws.close();
    }
  },

  /**
  * Connect socket.
  */
  connect: function() {
    var transport = this;

    if(this.ws && (this.readyState() === WebSocket.OPEN || this.readyState() === WebSocket.CONNECTING)) {
      logger.log('WebSocket ' + this.server.ws_uri + ' is already connected', this.ua);
      return false;
    }

    if(this.ws) {
      this.ws.close();
    }

    logger.log('connecting to WebSocket ' + this.server.ws_uri, this.ua);

    try {
      this.ws = new WebSocket(this.server.ws_uri, 'sip');
      this.ua.usedServers.push(this.server);
    } catch(e) {
      logger.warn('error connecting to WebSocket ' + this.server.ws_uri + ': ' + e, this.ua);
    }

    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = function() {
      transport.onOpen();
    };

    this.ws.onclose = function(e) {
      transport.onClose(e);
      this.onopen = null;
      this.onclose = null;
      this.onmessage = null;
      this.onerror = null;
    };

    this.ws.onmessage = function(e) {
      transport.onMessage(e);
    };

    this.ws.onerror = function(e) {
      transport.onError(e);
    };
  },

  // Transport Event Handlers

  /**
  * @event
  * @param {event} e
  */
  onOpen: function() {
    this.connected = true;

    logger.log('WebSocket ' + this.server.ws_uri + ' connected', this.ua);
    // Clear reconnectTimer since we are not disconnected
    window.clearTimeout(this.reconnectTimer);
    // Disable closed
    this.closed = false;
    // Trigger onTransportConnected callback
    this.ua.onTransportConnected(this);
  },

  /**
  * @event
  * @param {event} e
  */
  onClose: function(e) {
    var connected_before = this.connected;

    this.connected = false;
    this.lastTransportError.code = e.code;
    this.lastTransportError.reason = e.reason;
    logger.log('WebSocket disconnected (code: ' + e.code + (e.reason? '| reason: ' + e.reason : '') +')', this.ua);

    if(e.wasClean === false) {
      logger.warn('WebSocket abrupt disconnection', this.ua);
    }
    // Transport was connected
    if(connected_before === true) {
      this.ua.onTransportClosed(this);
      // Check whether the user requested to close.
      if(!this.closed) {
        // Reset reconnection_attempts
        this.reconnection_attempts = 0;
        this.reConnect();
      } else {
        this.ua.emit('disconnected', this.ua, {
          transport: this,
          code: this.lastTransportError.code,
          reason: this.lastTransportError.reason
        });
      }
    } else {
      // This is the first connection attempt
      //Network error
      this.ua.onTransportError(this);
    }
  },

  /**
  * @event
  * @param {event} e
  */
  onMessage: function(e) {
    var message, transaction,
      data = e.data;

    // CRLF Keep Alive response from server. Ignore it.
    if(data === '\r\n') {
      logger.debug('received WebSocket message with CRLF Keep Alive response', this.ua);
      return;
    }

    // WebSocket binary message.
    else if (typeof data !== 'string') {
      try {
        data = String.fromCharCode.apply(null, new Uint8Array(data));
      } catch(evt) {
        logger.warn('received WebSocket binary message failed to be converted into string, message discarded', this.ua);
        return;
      }

      logger.debug('received WebSocket binary message:\n\n' + data + '\n', this.ua);
    }

    // WebSocket text message.
    else {
      logger.debug('received WebSocket text message:\n\n' + data + '\n', this.ua);
    }

    message = ExSIP.Parser.parseMessage(this.ua, data);

    if(this.ua.status === ExSIP.UA.C.STATUS_USER_CLOSED && message instanceof ExSIP.IncomingRequest) {
      logger.debug('UA status is closed - not handling message\n', this.ua);
      return;
    }

    // Do some sanity check
    if(message && ExSIP.sanityCheck(message, this.ua, this)) {
      if(message instanceof ExSIP.IncomingRequest) {
        message.transport = this;
        this.ua.receiveRequest(message);
      } else if(message instanceof ExSIP.IncomingResponse) {
        /* Unike stated in 18.1.2, if a response does not match
        * any transaction, it is discarded here and no passed to the core
        * in order to be discarded there.
        */
        switch(message.method) {
          case ExSIP.C.INVITE:
            transaction = this.ua.transactions.ict[message.via_branch];
            if(transaction) {
              transaction.receiveResponse(message);
            } else {
              logger.warn("no ict transaction found for "+message.via_branch+" in "+ExSIP.Utils.toString(this.ua.transactions.ict), this.ua);
            }
            break;
          case ExSIP.C.ACK:
            // Just in case ;-)
            break;
          default:
            transaction = this.ua.transactions.nict[message.via_branch];
            if(transaction) {
              transaction.receiveResponse(message);
            }
            break;
        }
      } else {
        logger.debug('Message is not request nor response\n', this.ua);
      }
    } else {
      if(message) {
          logger.debug('Sanity check failed\n', this.ua);
      } else {
          logger.debug('Not a message\n', this.ua);
      }
    }
  },

  /**
  * @event
  * @param {event} e
  */
  onError: function(e) {
    logger.warn('WebSocket connection error: ' + e, this.ua);
  },

  /**
  * Reconnection attempt logic.
  * @private
  */
  reConnect: function() {
    var transport = this;

    this.reconnection_attempts += 1;

    if(this.reconnection_attempts > this.ua.configuration.ws_server_max_reconnection) {
      logger.warn('maximum reconnection attempts for WebSocket ' + this.server.ws_uri, this.ua);
      this.ua.onTransportError(this);
    } else {
      logger.log('trying to reconnect to WebSocket ' + this.server.ws_uri + ' (reconnection attempt ' + this.reconnection_attempts + ')', this.ua);

      if(this.ua.configuration.ws_server_reconnection_timeout === 0) {
        transport.connect();
      } else {
        this.reconnectTimer = window.setTimeout(function() {
          transport.connect();}, this.ua.configuration.ws_server_reconnection_timeout * 1000);
      }
    }
  }
};

Transport.C = C;
ExSIP.Transport = Transport;
}(ExSIP));
