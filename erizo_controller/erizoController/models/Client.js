/* eslint-disable no-param-reassign */

const events = require('events');
// eslint-disable-next-line import/no-extraneous-dependencies
const uuidv4 = require('uuid/v4');
const Permission = require('../permission');
const ST = require('./Stream');
const logger = require('./../../common/logger').logger;

const log = logger.getLogger('ErizoController - Client');

const PUBLISHER_INITAL = 101;
const PUBLISHER_READY = 104;

class Client extends events.EventEmitter {
  constructor(channel, token, options, room) {
    super();
    this.channel = channel;
    this.room = room;
    this.token = token;
    this.id = uuidv4();
    this.options = options;
    this.socketEventListeners = new Map();
    this.listenToSocketEvents();
    this.user = { name: token.userName, role: token.role, permissions: {} };
    const permissions = global.config.erizoController.roles[token.role] || {};
    Object.keys(permissions).forEach((right) => {
      this.user.permissions[right] = permissions[right];
    });
    this.streams = []; // [list of streamIds]
    this.state = 'sleeping'; // ?
  }

  listenToSocketEvents() {
    log.debug(`message: Adding listeners to socket events, client.id: ${this.id}`);
    this.socketEventListeners.set('sendDataStream', this.onSendDataStream.bind(this));
    this.socketEventListeners.set('signaling_message', this.onSignalingMessage.bind(this));
    this.socketEventListeners.set('updateStreamAttributes', this.onUpdateStreamAttributes.bind(this));
    this.socketEventListeners.set('publish', this.onPublish.bind(this));
    this.socketEventListeners.set('subscribe', this.onSubscribe.bind(this));
    this.socketEventListeners.set('startRecorder', this.onStartRecorder.bind(this));
    this.socketEventListeners.set('stopRecorder', this.onStopRecorder.bind(this));
    this.socketEventListeners.set('unpublish', this.onUnpublish.bind(this));
    this.socketEventListeners.set('unsubscribe', this.onUnsubscribe.bind(this));
    this.socketEventListeners.set('autoSubscribe', this.onAutoSubscribe.bind(this));
    this.socketEventListeners.set('getStreamStats', this.onGetStreamStats.bind(this));
    this.socketEventListeners.forEach((value, key) => {
      this.channel.socketOn(key, value);
    });
    this.channel.on('disconnect', this.onDisconnect.bind(this));
  }
  stopListeningToSocketEvents() {
    log.debug(`message: Removing listeners to socket events, client.id: ${this.id}`);
    this.socketEventListeners.forEach((value, key) => {
      this.channel.socketRemoveListener(key, value);
    });
  }

  disconnect() {
    this.stopListeningToSocketEvents();
    this.channel.disconnect();
  }

  setNewChannel(channel) {
    const oldChannel = this.channel;
    const buffer = oldChannel.getBuffer();
    log.info('message: reconnected, oldChannelId:', oldChannel.id, ', channelId:', channel.id);
    oldChannel.removeAllListeners();
    oldChannel.disconnect();
    this.channel = channel;
    this.listenToSocketEvents();
    this.channel.sendBuffer(buffer);
  }

  setSelectors(selectors, negativeSelectors, options) {
    this.selectors = selectors;
    this.negativeSelectors = negativeSelectors;
    this.selectorOptions = options;
    this.onInternalAutoSubscriptionChange();
  }

  onInternalAutoSubscriptionChange() {
    if (!this.selectors && !this.negativeSelectors) {
      return;
    }
    const subscribableStreams = [];
    const unsubscribableStreams = [];
    this.room.forEachStream((stream) => {
      // We don't subscribe/unsubscribe to own published
      if (this.streams.indexOf(stream.getID()) !== -1) {
        return;
      }
      if (stream.meetAnySelector(this.selectors) &&
          !stream.meetAnySelector(this.negativeSelectors)) {
        if (stream.hasData() && this.options.data !== false) {
          stream.addDataSubscriber(this.id);
        }
        if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
          subscribableStreams.push(stream);
        }
      } else {
        if (stream.hasData() && this.options.data !== false) {
          stream.removeDataSubscriber(this.id);
        }
        if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
          unsubscribableStreams.push(stream);
        }
      }
    });
    if (subscribableStreams.length > 0) {
      this.onMultipleSubscribe(subscribableStreams, this.selectorOptions);
    }
    if (unsubscribableStreams.length > 0) {
      this.onMultipleUnsubscribe(unsubscribableStreams);
    }
  }

  onMultipleSubscribe(streams, options = {}) {
    if (this.room.p2p) {
      streams.forEach((stream) => {
        const clientId = stream.getClient();
        const client = this.room.getClientById(clientId);
        client.sendMessage('publish_me', { streamId: stream.getID(), peerSocket: this.id });
      });
      return;
    }
    log.info('message: addMultipleSubscribers requested, ' +
                 `streams: ${streams}, ` +
                 `clientId: ${this.id}`);
    options.mediaConfiguration = this.token.mediaConfiguration;
    options.singlePC = this.options.singlePC || false;
    const streamIds = streams.map(stream => stream.getID());
    this.room.controller.addMultipleSubscribers(this.id, streamIds, options, (signMess) => {
      // We can receive multiple initializing messages with subsets of streamIds. Each subset
      // is sent from a single ErizoJS.
      if (signMess.type === 'initializing') {
        log.info('message: addMultipleSubscribers, ' +
                         'state: SUBSCRIBER_INITIAL, ' +
                         `clientId: ${this.id}, ` +
                         `streamIds: ${signMess.streamIds}`);
        if (global.config.erizoController.report.session_events) {
          const timeStamp = new Date();
          if (signMess.streamIds) {
            signMess.streamIds.forEach((streamId) => {
              this.room.amqper.broadcast('event', { room: this.room.id,
                user: this.id,
                name: this.user.name,
                type: 'subscribe',
                stream: streamId,
                timestamp: timeStamp.getTime() });
            });
          }
        }
      } else if (signMess.type === 'failed') {
        // TODO: Add Stats event
        log.warn('message: addMultipleSubscribers ICE Failed, ' +
                         'state: SUBSCRIBER_FAILED, ' +
                         `streamId: ${signMess.streamId}, ` +
                         `clientId: ${this.id}`);
        this.sendMessage('connection_failed', { type: 'subscribe',
          streamId: signMess.streamId });
        return;
      } else if (signMess.type === 'ready') {
        log.info('message: addMultipleSubscribers, ' +
                         'state: SUBSCRIBER_READY, ' +
                         `streamId: ${signMess.streamId}, ` +
                         `clientId: ${this.id}`);
      } else if (signMess.type === 'bandwidthAlert') {
        this.sendMessage('onBandwidthAlert', { streamID: signMess.streamId,
          message: signMess.message,
          bandwidth: signMess.bandwidth });
        return;
      } else if (signMess === 'timeout') {
        log.error('message: addMultipleSubscribers timeout when contacting ErizoJS, ' +
                          `streamId: ${signMess.streamId}, ` +
                          `clientId: ${this.id}`);
        return;
      }

      this.sendMessage('signaling_message_erizo', { mess: signMess,
        options,
        context: signMess.context,
        peerIds: signMess.streamIds });
    });
  }

  onMultipleUnsubscribe(streams) {
    if (this.room.p2p) {
      streams.forEach((stream) => {
        const clientId = stream.getClient();
        const client = this.room.getClientById(clientId);
        client.sendMessage('unpublish_me', { streamId: stream.getID(), peerSocket: this.id });
      });
      return;
    }
    const streamIds = streams.map(stream => stream.getID());
    log.debug('message: removeMultipleSubscribers requested, ' +
      `streamIds: ${streamIds}, ` +
      `clientId: ${this.id}`);

    this.room.controller.removeMultipleSubscribers(this.id, streamIds, (signMess) => {
      if (global.config.erizoController.report.session_events) {
        if (signMess === 'timeout') {
          log.error('message: removeMultipleSubscribers timeout when contacting ErizoJS, ' +
                            `streamId: ${signMess.streamId}, ` +
                            `clientId: ${this.id}`);
          return;
        }

        const timeStamp = new Date();
        signMess.streamIds.forEach((streamId) => {
          this.room.amqper.broadcast('event', { room: this.room.id,
            user: this.id,
            type: 'unsubscribe',
            stream: streamId,
            timestamp: timeStamp.getTime() });
        });
      }

      this.sendMessage('signaling_message_erizo', { mess: signMess,
        options: {},
        context: signMess.context,
        peerIds: signMess.streamIds });
    });
  }

  sendMessage(type, arg) {
    this.channel.sendMessage(type, arg);
  }

  hasPermission(action, options = false) {
    if (this.user === undefined || !this.user.permissions[action]) {
      return false;
    }

    if (options && this.user.permissions[action] !== true) {
      const permissions = this.user.permissions[action];
      const result = Object.keys(permissions).every((permissionAction) => {
        if ((options[permissionAction] === true) && (permissions[permissionAction] === false)) {
          return false;
        }
        return true;
      });
      return result;
    }
    return true;
  }

  onSendDataStream(message) {
    const stream = this.room.getStreamById(message.id);
    if (stream === undefined) {
      log.warn('message: Trying to send Data from a non-initialized stream, ' +
               `clientId: ${this.id}`, logger.objectToLog(message));
      return;
    }
    stream.forEachDataSubscriber((index, dataSubscriber) => {
      const client = this.room.getClientById(dataSubscriber);
      if (client) {
        log.debug('message: sending dataStream, ' +
          `clientId: ${dataSubscriber}, dataStream: ${message.id}`);
        this.room.getClientById(dataSubscriber).sendMessage('onDataStream', message);
      }
    });
  }

  onSignalingMessage(message) {
    if (this.room === undefined) {
      log.error('message: singaling_message for user in undefined room' +
        `, streamId: ${message.streamId}, user: ${this.user}`);
      this.disconnect();
    }
    if (this.room.p2p) {
      const targetClient = this.room.getClientById(message.peerSocket);
      if (targetClient) {
        targetClient.sendMessage('signaling_message_peer',
          { streamId: message.streamIds || message.streamId,
            peerSocket: this.id,
            msg: message.msg });
      }
    } else {
      const isControlMessage = message.msg.type === 'control';
      if (!isControlMessage ||
            (isControlMessage && this.hasPermission(message.msg.action.name))) {
        this.room.controller.processSignaling(this.id, message.streamIds ||
          message.streamId, message.msg);
      } else {
        log.info('message: User unauthorized to execute action on stream, action: ' +
          `${message.msg.action.name}, streamId: ${message.streamId}`);
      }
    }
  }

  onUpdateStreamAttributes(message) {
    const stream = this.room.getStreamById(message.id);
    if (stream === undefined) {
      log.warn('message: Update attributes to a uninitialized stream ',
        logger.objectToLog(message));
      return;
    }
    stream.setAttributes(message.attrs);
    stream.forEachDataSubscriber((index, dataSubscriber) => {
      const client = this.room.getClientById(dataSubscriber);
      if (client) {
        log.debug('message: Sending new attributes, ' +
                      `clientId: ${dataSubscriber}, streamId: ${message.id}`);
        client.sendMessage('onUpdateAttributeStream', message);
      }
    });
    this.room.forEachClient((client) => {
      client.onInternalAutoSubscriptionChange();
    });
  }

  onPublish(options, sdp, callback) {
    if (!this.hasPermission(Permission.PUBLISH, options)) {
      callback(null, 'Unauthorized');
      return;
    }
    // generate a 18 digits safe integer
    const id = Math.floor(100000000000000000 + (Math.random() * 900000000000000000));

    if (options.state === 'url' || options.state === 'recording') {
      let url = sdp;
      if (options.state === 'recording') {
        const recordingId = sdp;
        if (global.config.erizoController.recording_path) {
          url = `${global.config.erizoController.recording_path + recordingId}.mkv`;
        } else {
          url = `/tmp/${recordingId}.mkv`;
        }
      }
      this.room.controller.addExternalInput(id, url, (result) => {
        if (result === 'success') {
          const st = ST.Stream({ id,
            client: this.id,
            audio: options.audio,
            video: options.video,
            data: options.data,
            label: options.label,
            attributes: options.attributes });
          st.status = PUBLISHER_READY;
          this.streams.push(id);
          this.room.streams.set(id, st);
          callback(id);
          this.room.sendMessage('onAddStream', st.getPublicStream());
        } else {
          callback(null, `Error adding External Input:${result}`);
        }
      });
    } else if (options.state === 'erizo') {
      let st;
      options.mediaConfiguration = this.token.mediaConfiguration;
      options.singlePC = this.options.singlePC || false;
      log.info('message: addPublisher requested, ' +
        `streamId: ${id}, clientId: ${this.id}`,
        logger.objectToLog(options),
        logger.objectToLog(options.attributes));
      this.room.controller.addPublisher(this.id, id, options, (signMess) => {
        if (signMess.type === 'initializing') {
          callback(id, signMess.erizoId);
          st = ST.Stream({ id,
            client: this.id,
            audio: options.audio,
            video: options.video,
            data: options.data,
            label: options.label,
            screen: options.screen,
            attributes: options.attributes });
          this.streams.push(id);
          this.room.streams.set(id, st);
          st.status = PUBLISHER_INITAL;
          log.info('message: addPublisher, ' +
                         `label: ${options.label}, ` +
                         'state: PUBLISHER_INITIAL, ' +
                         `clientId: ${this.id}, ` +
                         `streamId: ${id}`);

          if (global.config.erizoController.report.session_events) {
            const timeStamp = new Date();
            this.room.amqper.broadcast('event', { room: this.room.id,
              user: this.id,
              name: this.user.name,
              type: 'publish',
              stream: id,
              timestamp: timeStamp.getTime(),
              agent: signMess.agentId,
              attributes: options.attributes });
          }
        } else if (signMess.type === 'failed') {
          log.warn('message: addPublisher ICE Failed, ' +
                         'state: PUBLISHER_FAILED, ' +
                         `streamId: ${id}, ` +
                         `clientId: ${this.id}`);
          this.sendMessage('connection_failed', { type: 'publish', streamId: id });
                // We're going to let the client disconnect
          return;
        } else if (signMess.type === 'ready') {
          st.status = PUBLISHER_READY;
          this.room.forEachClient((client) => {
            client.onInternalAutoSubscriptionChange();
          });
          this.room.sendMessage('onAddStream', st.getPublicStream());
          log.info('message: addPublisher, ' +
                         'state: PUBLISHER_READY, ' +
                         `streamId: ${id}, ` +
                         `clientId: ${this.id}`);
        } else if (signMess === 'timeout-erizojs') {
          log.error('message: addPublisher timeout when contacting ErizoJS, ' +
                          `streamId: ${id}, clientId: ${this.id}`);
          callback(null, null, 'ErizoJS is not reachable');
          return;
        } else if (signMess === 'timeout-agent') {
          log.error('message: addPublisher timeout when contacting Agent, ' +
                          `streamId: ${id}, clientId: ${this.id}`);
          callback(null, null, 'ErizoAgent is not reachable');
          return;
        } else if (signMess === 'timeout') {
          log.error('message: addPublisher Undefined RPC Timeout, ' +
                          `streamId: ${id}, clientId: ${this.id}`);
          callback(null, null, 'ErizoAgent or ErizoJS is not reachable');
          return;
        }
        log.debug('Sending message back to the client', id);
        this.sendMessage('signaling_message_erizo', { mess: signMess, streamId: id });
      });
    } else {
      const st = ST.Stream({ id,
        client: this.id,
        audio: options.audio,
        video: options.video,
        data: options.data,
        label: options.label,
        screen: options.screen,
        attributes: options.attributes });
      this.streams.push(id);
      this.room.streams.set(id, st);
      st.status = PUBLISHER_READY;
      callback(id);
      this.room.sendMessage('onAddStream', st.getPublicStream());
    }
  }

  onSubscribe(options, sdp, callback) {
    if (!this.hasPermission(Permission.SUBSCRIBE, options)) {
      callback(null, 'Unauthorized');
      return;
    }

    const stream = this.room.getStreamById(options.streamId);
    if (stream === undefined) {
      return;
    }

    if (stream.hasData() && options.data !== false) {
      stream.addDataSubscriber(this.id);
    }

    if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
      if (this.room.p2p) {
        const clientId = stream.getClient();
        const client = this.room.getClientById(clientId);
        client.sendMessage('publish_me', { streamId: options.streamId, peerSocket: this.id });
      } else {
        log.info('message: addSubscriber requested, ' +
                     `streamId: ${options.streamId}, ` +
                     `clientId: ${this.id}`);
        options.mediaConfiguration = this.token.mediaConfiguration;
        options.singlePC = this.options.singlePC || false;
        this.room.controller.addSubscriber(this.id, options.streamId, options, (signMess) => {
          if (signMess.type === 'initializing') {
            log.info('message: addSubscriber, ' +
                             'state: SUBSCRIBER_INITIAL, ' +
                             `clientId: ${this.id}, ` +
                             `streamId: ${options.streamId}`);
            callback(true, signMess.erizoId);
            if (global.config.erizoController.report.session_events) {
              const timeStamp = new Date();
              this.room.amqper.broadcast('event', { room: this.room.id,
                user: this.id,
                name: this.user.name,
                type: 'subscribe',
                stream: options.streamId,
                timestamp: timeStamp.getTime() });
            }
            return;
          } else if (signMess.type === 'failed') {
                    // TODO: Add Stats event
            log.warn('message: addSubscriber ICE Failed, ' +
                             'state: SUBSCRIBER_FAILED, ' +
                             `streamId: ${options.streamId}, ` +
                             `clientId: ${this.id}`);
            this.sendMessage('connection_failed', { type: 'subscribe',
              streamId: options.streamId });
            return;
          } else if (signMess.type === 'ready') {
            log.info('message: addSubscriber, ' +
                             'state: SUBSCRIBER_READY, ' +
                             `streamId: ${options.streamId}, ` +
                             `clientId: ${this.id}`);
          } else if (signMess.type === 'bandwidthAlert') {
            this.sendMessage('onBandwidthAlert', { streamID: options.streamId,
              message: signMess.message,
              bandwidth: signMess.bandwidth });
          } else if (signMess === 'timeout') {
            log.error('message: addSubscriber timeout when contacting ErizoJS, ' +
                              `streamId: ${options.streamId}, ` +
                              `clientId: ${this.id}`);
            callback(null, null, 'ErizoJS is not reachable');
            return;
          }

          this.sendMessage('signaling_message_erizo', { mess: signMess,
            peerId: options.streamId });
        });
      }
    } else {
      callback(true);
    }
  }

  onStartRecorder(options, callback) {
    if (!this.hasPermission(Permission.RECORD)) {
      callback(null, 'Unauthorized');
      return;
    }
    const streamId = options.to;
    const recordingId = Math.random() * 1000000000000000000;
    let url;

    if (global.config.erizoController.recording_path) {
      url = `${global.config.erizoController.recording_path + recordingId}.mkv`;
    } else {
      url = `/tmp/${recordingId}.mkv`;
    }

    log.info('message: startRecorder, ' +
             'state: RECORD_REQUESTED, ' +
             `streamId: ${streamId}, ` +
             `url: ${url}`);

    if (this.room.p2p) {
      callback(null, 'Stream can not be recorded');
    }

    const stream = this.room.getStreamById(streamId);

    if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
      const mediaOptions = { mediaConfiguration: this.token.mediaConfiguration };
      this.room.controller.addExternalOutput(streamId, url, mediaOptions, (result) => {
        if (result === 'success') {
          log.info('message: startRecorder, ' +
                         'state: RECORD_STARTED, ' +
                         `streamId: ${streamId}, ` +
                         `url: ${url}`);
          callback(recordingId);
        } else {
          log.warn('message: startRecorder stream not found, ' +
                         'state: RECORD_FAILED, ' +
                         `streamId: ${streamId}, ` +
                         `url: ${url}`);
          callback(null, 'Unable to subscribe to stream for recording, ' +
                               'publisher not present');
        }
      });
    } else {
      log.warn('message: startRecorder stream cannot be recorded, ' +
                 'state: RECORD_FAILED, ' +
                 `streamId: ${streamId}, ` +
                 `url: ${url}`);
      callback(null, 'Stream can not be recorded');
    }
  }

  onStopRecorder(options, callback) {
    if (!this.hasPermission(Permission.RECORD)) {
      if (callback) callback(null, 'Unauthorized');
      return;
    }
    const recordingId = options.id;
    let url;

    if (global.config.erizoController.recording_path) {
      url = `${global.config.erizoController.recording_path + recordingId}.mkv`;
    } else {
      url = `/tmp/${recordingId}.mkv`;
    }

    log.info('message: startRecorder, ' +
             'state: RECORD_STOPPED, ' +
             `streamId: ${options.id}, ` +
             `url: ${url}`);
    this.room.controller.removeExternalOutput(url, callback);
  }

  onUnpublish(streamId, callback) {
    if (!this.hasPermission(Permission.PUBLISH)) {
      if (callback) callback(null, 'Unauthorized');
      return;
    }

    // Stream has been already deleted or it does not exist
    const stream = this.room.getStreamById(streamId);
    if (stream === undefined) {
      return;
    }

    if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
      this.state = 'sleeping';
      if (!this.room.p2p) {
        this.room.controller.removePublisher(this.id, streamId, () => {
          if (global.config.erizoController.report.session_events) {
            const timeStamp = new Date();
            this.room.amqper.broadcast('event', { room: this.room.id,
              user: this.id,
              type: 'unpublish',
              stream: streamId,
              timestamp: timeStamp.getTime() });
          }
          this.room.sendMessage('onRemoveStream', { id: streamId });
          callback(true);
        });
      } else {
        this.room.sendMessage('onRemoveStream', { id: streamId });
      }
    }

    const index = this.streams.indexOf(streamId);
    if (index !== -1) {
      this.streams.splice(index, 1);
    }
    this.room.removeStream(streamId);
    if (this.room.p2p) {
      callback(true);
    }
  }

  onUnsubscribe(to, callback) {
    if (!this.hasPermission(Permission.SUBSCRIBE)) {
      if (callback) callback(null, 'Unauthorized');
      return;
    }

    const stream = this.room.getStreamById(to);
    if (stream === undefined) {
      return;
    }

    stream.removeDataSubscriber(this.id);

    if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
      if (this.room.p2p) {
        const clientId = stream.getClient();
        const client = this.room.getClientById(clientId);
        client.sendMessage('unpublish_me', { streamId: stream.getID(), peerSocket: this.id });
        callback(true);
      } else {
        this.room.controller.removeSubscriber(this.id, to, (result) => {
          if (global.config.erizoController.report.session_events) {
            const timeStamp = new Date();
            this.room.amqper.broadcast('event', { room: this.room.id,
              user: this.id,
              type: 'unsubscribe',
              stream: to,
              timestamp: timeStamp.getTime() });
          }
          callback(result);
        });
      }
    }
  }

  onAutoSubscribe(data, callback = () => {}) {
    if (!this.hasPermission(Permission.SUBSCRIBE)) {
      if (callback) callback(null, 'Unauthorized');
      return;
    }

    const selectors = (data && data.selectors) || {};
    const negativeSelectors = (data && data.negativeSelectors) || {};
    const options = (data && data.options) || {};

    this.setSelectors(selectors, negativeSelectors, options);
    callback();
  }

  onDisconnect() {
    this.stopListeningToSocketEvents();
    const timeStamp = new Date();

    log.info(`message: Channel disconnect, clientId: ${this.id}`, ', channelId:', this.channel.id);

    this.streams.forEach((streamId) => {
      this.room.sendMessage('onRemoveStream', { id: streamId });
    });

    if (this.room !== undefined) {
      this.room.forEachStream((stream) => {
        stream.removeDataSubscriber(this.id);
        if (this.room.p2p) {
          const clientId = stream.getClient();
          const client = this.room.getClientById(clientId);
          client.sendMessage('unpublish_me', { streamId: stream.getID(), peerSocket: this.id });
        }
      });

      this.room.removeClient(this.id);

      if (this.room.controller) {
        this.room.controller.removeSubscriptions(this.id);
      }

      this.streams.forEach((streamId) => {
        const stream = this.room.getStreamById(streamId);
        if (stream !== undefined) {
          if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
            if (!this.room.p2p) {
              log.info('message: Unpublishing stream, streamId:', streamId);
              this.room.controller.removePublisher(this.id, streamId);
              if (global.config.erizoController.report.session_events) {
                this.room.amqper.broadcast('event', { room: this.room.id,
                  user: this.id,
                  type: 'unpublish',
                  stream: streamId,
                  timestamp: timeStamp.getTime() });
              }
            }
          }
          this.room.removeStream(streamId);
        }
      });

      if (!this.room.p2p &&
          global.config.erizoController.report.session_events) {
        this.room.amqper.broadcast('event', { room: this.room.id,
          user: this.id,
          type: 'user_disconnection',
          timestamp: timeStamp.getTime() });
      }

      this.emit('disconnect');
    }
  }

  onGetStreamStats(streamId, callback) {
    log.debug(`message: getting stats, streamId: ${streamId}`);
    if (!this.hasPermission(Permission.STATS)) {
      log.info('message: unauthorized getStreamStats request');
      if (callback) callback(null, 'Unauthorized');
      return;
    }
    if (this.room.getStreamById(streamId) === undefined) {
      log.info('message: bad getStreamStats request');
      return;
    }
    if (this.room !== undefined && !this.room.p2p) {
      this.room.controller.getStreamStats(streamId, (result) => {
        callback(result);
      });
    }
  }

}

exports.Client = Client;
