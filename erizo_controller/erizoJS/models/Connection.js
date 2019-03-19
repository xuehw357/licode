/* global require, exports */


const events = require('events');
// eslint-disable-next-line import/no-unresolved
const addon = require('./../../../erizoAPI/build/Release/addon');
const logger = require('./../../common/logger').logger;
const SessionDescription = require('./SessionDescription');
const SemanticSdp = require('./../../common/semanticSdp/SemanticSdp');
const Helpers = require('./Helpers');

const log = logger.getLogger('Connection');

const CONN_INITIAL = 101;
// CONN_STARTED        = 102,
const CONN_GATHERED = 103;
const CONN_READY = 104;
const CONN_FINISHED = 105;
const CONN_CANDIDATE = 201;
const CONN_SDP = 202;
const CONN_SDP_PROCESSED = 203;
const CONN_FAILED = 500;
const WARN_BAD_CONNECTION = 502;

const RESEND_LAST_ANSWER_RETRY_TIMEOUT = 50;

class Connection extends events.EventEmitter {
  constructor(id, threadPool, ioThreadPool, options = {}) {
    super();
    log.info(`message: constructor, id: ${id}`);
    this.id = id;
    this.threadPool = threadPool;
    this.ioThreadPool = ioThreadPool;
    this.mediaConfiguration = 'default';
    //  {id: stream}
    this.mediaStreams = new Map();
    this.wrtc = this._createWrtc();
    this.initialized = false;
    this.options = options;
    this.trickleIce = options.trickleIce || false;
    this.metadata = this.options.metadata || {};
    this.isNegotiating = false;
    this.ready = false;
    this.gatheredPromise = new Promise((resolve, reject) => {
      this._gatheredResolveFunction = resolve;
      this._gatheredRejectFunction = reject;
    });
  }

  static _getMediaConfiguration(mediaConfiguration = 'default') {
    if (global.mediaConfig && global.mediaConfig.codecConfigurations) {
      if (global.mediaConfig.codecConfigurations[mediaConfiguration]) {
        return JSON.stringify(global.mediaConfig.codecConfigurations[mediaConfiguration]);
      } else if (global.mediaConfig.codecConfigurations.default) {
        return JSON.stringify(global.mediaConfig.codecConfigurations.default);
      }
      log.warn(
        'message: Bad media config file. You need to specify a default codecConfiguration.');
      return JSON.stringify({});
    }
    log.warn(
      'message: Bad media config file. You need to specify a default codecConfiguration.');
    return JSON.stringify({});
  }

  _createWrtc() {
    const wrtc = new addon.WebRtcConnection(this.threadPool, this.ioThreadPool, this.id,
      global.config.erizo.stunserver,
      global.config.erizo.stunport,
      global.config.erizo.minport,
      global.config.erizo.maxport,
      this.trickleIce,
      Connection._getMediaConfiguration(this.mediaConfiguration),
      global.config.erizo.useNicer,
      global.config.erizo.turnserver,
      global.config.erizo.turnport,
      global.config.erizo.turnusername,
      global.config.erizo.turnpass,
      global.config.erizo.networkinterface);

    if (this.metadata) {
      wrtc.setMetadata(JSON.stringify(this.metadata));
    }
    return wrtc;
  }

  _createMediaStream(id, options = {}, isPublisher = true) {
    log.debug(`message: _createMediaStream, connectionId: ${this.id}, ` +
              `mediaStreamId: ${id}, isPublisher: ${isPublisher}`);
    const mediaStream = new addon.MediaStream(this.threadPool, this.wrtc, id,
      options.label, Connection._getMediaConfiguration(this.mediaConfiguration), isPublisher);
    mediaStream.id = id;
    mediaStream.label = options.label;
    if (options.metadata) {
      mediaStream.metadata = options.metadata;
      mediaStream.setMetadata(JSON.stringify(options.metadata));
    }
    mediaStream.onMediaStreamEvent((type, message) => {
      this._onMediaStreamEvent(type, message, mediaStream.id);
    });
    return mediaStream;
  }

  _onMediaStreamEvent(type, message, mediaStreamId) {
    const streamEvent = {
      type,
      mediaStreamId,
      message,
    };
    this.emit('media_stream_event', streamEvent);
  }

  createAnswer() {
    return { type: 'answer', sdp: this.getLocalSdp() };
  }

  createOffer() {
    return { type: 'offer', sdp: this.getLocalSdp() };
  }

  getLocalSdp() {
    this.wrtc.localDescription = new SessionDescription(this.wrtc.getLocalDescription());
    const sdp = this.wrtc.localDescription.getSdp(this.sessionVersion);
    this.sessionVersion += 1;
    let message = sdp.toString();
    message = message.replace(this.options.privateRegexp, this.options.publicIP);
    return message;
  }

  _maybeSendAnswer(evt, streamId, forceOffer = false) {
    if (this.isNegotiating) {
      return;
    }
    if (!this.alreadyGathered && !this.trickleIce) {
      return;
    }
    const info = this.options.createOffer || forceOffer ? this.createOffer() : this.createAnswer();
    log.debug(`message: _maybeSendAnswer sending event, type: ${info.type}, streamId: ${streamId}, sessionVersion: ${this.sessionVersion}`);
    this.emit('status_event', info, evt, streamId);
  }

  _resendLastAnswer(evt, streamId, label, forceOffer = false, removeStream = false) {
    if (!this.wrtc || !this.wrtc.localDescription) {
      log.debug('message: _resendLastAnswer, this.wrtc or this.wrtc.localDescription are not present');
      return Promise.reject('fail');
    }
    this.wrtc.localDescription = new SessionDescription(this.wrtc.getLocalDescription());
    const sdp = this.wrtc.localDescription.getSdp(this.sessionVersion);
    const stream = sdp.getStream(label);
    if (stream && removeStream) {
      log.info(`resendLastAnswer: StreamId ${streamId} is stream and removeStream, label ${label}, sessionVersion ${this.sessionVersion}`);
      return Promise.reject('retry');
    }
    this.sessionVersion += 1;
    let message = sdp.toString();
    message = message.replace(this.options.privateRegexp, this.options.publicIP);

    const info = { type: this.options.createOffer || forceOffer ? 'offer' : 'answer', sdp: message };
    log.debug(`message: _resendLastAnswer sending event, type: ${info.type}, streamId: ${streamId}`);
    this.emit('status_event', info, evt, streamId);
    return Promise.resolve();
  }

  init(newStreamId, createOffer = this.options.createOffer) {
    if (this.initialized) {
      return false;
    }
    const firstStreamId = newStreamId;
    this.initialized = true;
    log.debug(`message: Init Connection, connectionId: ${this.id} `,
      logger.objectToLog(this.options));
    this.sessionVersion = 0;

    this.wrtc.init((newStatus, mess, streamId) => {
      log.info('message: WebRtcConnection status update, ' +
        `id: ${this.id}, status: ${newStatus}`,
        logger.objectToLog(this.metadata));
      switch (newStatus) {
        case CONN_INITIAL:
          this.emit('status_event', { type: 'started' }, newStatus);
          break;

        case CONN_SDP_PROCESSED:
          this.isNegotiating = false;
          this._maybeSendAnswer(newStatus, streamId);
          break;

        case CONN_SDP:
          this._maybeSendAnswer(newStatus, streamId);
          break;

        case CONN_GATHERED:
          this._gatheredResolveFunction();
          this.alreadyGathered = true;
          this._maybeSendAnswer(newStatus, firstStreamId, createOffer);
          break;

        case CONN_CANDIDATE:
          // eslint-disable-next-line no-param-reassign
          mess = mess.replace(this.options.privateRegexp, this.options.publicIP);
          this.emit('status_event', { type: 'candidate', candidate: mess }, newStatus);
          break;

        case CONN_FAILED:
          log.warn(`message: failed the ICE process, code: ${WARN_BAD_CONNECTION},` +
            `id: ${this.id}`);
          this.emit('status_event', { type: 'failed', sdp: mess }, newStatus);
          break;

        case CONN_READY:
          log.debug(`message: connection ready, id: ${this.id} status: ${newStatus}`);
          this.ready = true;
          this.emit('status_event', { type: 'ready' }, newStatus);
          break;
        default:
          log.error(`message: unknown webrtc status ${newStatus}`);
      }
    });
    if (createOffer) {
      log.debug('message: create offer requested, id:', this.id);
      const audioEnabled = createOffer.audio;
      const videoEnabled = createOffer.video;
      const bundle = createOffer.bundle;
      this.createOfferPromise = this.wrtc.createOffer(videoEnabled, audioEnabled, bundle);
    }
    this.emit('status_event', { type: 'initializing' });
    return true;
  }

  addMediaStream(id, options, isPublisher) {
    let promise = Promise.resolve();
    log.info(`message: addMediaStream, connectionId: ${this.id}, mediaStreamId: ${id}`);
    if (this.mediaStreams.get(id) === undefined) {
      const mediaStream = this._createMediaStream(id, options, isPublisher);
      promise = this.wrtc.addMediaStream(mediaStream);
      this.mediaStreams.set(id, mediaStream);
    }
    return promise;
  }

  removeMediaStream(id, sendOffer = true) {
    let promise = Promise.resolve();
    if (this.mediaStreams.get(id) !== undefined) {
      const label = this.mediaStreams.get(id).label;
      promise = this.wrtc.removeMediaStream(id);
      this.mediaStreams.get(id).close();
      this.mediaStreams.delete(id);
      return Helpers.retryWithPromise(
        this._resendLastAnswer.bind(this, CONN_SDP, id, label, sendOffer, true),
        RESEND_LAST_ANSWER_RETRY_TIMEOUT);
    }
    log.error(`message: Trying to remove mediaStream not found, id: ${id}`);
    return promise;
  }

  setRemoteDescription(sdp, streamIds) {
    this.remoteDescription = new SessionDescription(sdp, this.mediaConfiguration);
    this.wrtc.setRemoteDescription(this.remoteDescription.connectionDescription, streamIds);
  }

  processOffer(sdp, streamsId) {
    const sdpInfo = SemanticSdp.SDPInfo.processString(sdp);
    this.setRemoteDescription(sdpInfo, streamsId);
  }

  processAnswer(sdp, streamsId) {
    this.isNegotiating = false;
    const sdpInfo = SemanticSdp.SDPInfo.processString(sdp);
    this.setRemoteDescription(sdpInfo, streamsId);
  }

  addRemoteCandidate(candidate) {
    this.wrtc.addRemoteCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.candidate);
  }

  getMediaStream(id) {
    return this.mediaStreams.get(id);
  }

  getNumMediaStreams() {
    return this.mediaStreams.size;
  }

  close() {
    log.info(`message: Closing connection ${this.id}`);
    log.info(`message: WebRtcConnection status update, id: ${this.id}, status: ${CONN_FINISHED}, ` +
            `${logger.objectToLog(this.metadata)}`);
    this.mediaStreams.forEach((mediaStream, id) => {
      log.debug(`message: Closing mediaStream, connectionId : ${this.id}, ` +
        `mediaStreamId: ${id}`);
      mediaStream.close();
    });
    this.wrtc.close();
    delete this.mediaStreams;
    delete this.wrtc;
  }

}
exports.Connection = Connection;
