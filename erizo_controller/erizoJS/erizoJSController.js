/* global require, exports, setInterval, clearInterval, Promise */


const logger = require('./../common/logger').logger;
const amqper = require('./../common/amqper');
const RovReplManager = require('./../common/ROV/rovReplManager').RovReplManager;
const Client = require('./models/Client').Client;
const Publisher = require('./models/Publisher').Publisher;
const ExternalInput = require('./models/Publisher').ExternalInput;

// Logger
const log = logger.getLogger('ErizoJSController');

exports.ErizoJSController = (threadPool, ioThreadPool) => {
  const that = {};
  // {streamId1: Publisher, streamId2: Publisher}
  const publishers = {};
  // {clientId: Client}
  const clients = new Map();
  const replManager = new RovReplManager(that);
  const io = ioThreadPool;
  // {streamId: {timeout: timeout, interval: interval}}
  const statsSubscriptions = {};
  const WARN_NOT_FOUND = 404;
  const WARN_CONFLICT = 409;

  const MAX_INACTIVE_UPTIME = global.config.erizo.activeUptimeLimit * 24 * 60 * 60 * 1000;
  const MAX_TIME_SINCE_LAST_OP =
    global.config.erizo.maxTimeSinceLastOperation * 60 * 60 * 1000;

  const uptimeStats = {
    startTime: 0,
    lastOperation: 0,
  };

  const checkUptimeStats = () => {
    const now = new Date();
    const timeSinceStart = now.getTime() - uptimeStats.startTime.getTime();
    const timeSinceLastOperation = now.getTime() - uptimeStats.lastOperation.getTime();
    log.debug(`Checking uptime - timeSinceStart: ${timeSinceStart}, timeSinceLastOperation ${timeSinceLastOperation}, max since start ${MAX_INACTIVE_UPTIME}, max since opf ${MAX_TIME_SINCE_LAST_OP}`);
    if (timeSinceStart > MAX_INACTIVE_UPTIME &&
      timeSinceLastOperation > MAX_TIME_SINCE_LAST_OP) {
      log.error(`Shutting down ErizoJS - uptime: ${timeSinceStart}, timeSinceLastOperation ${timeSinceLastOperation}`);
      process.exit(0);
    }
  };

  const updateUptimeInfo = () => {
    uptimeStats.lastOperation = new Date();
    if (uptimeStats.startTime === 0) {
      log.info('Start checking uptime, interval', global.config.erizo.checkUptimeInterval);
      uptimeStats.startTime = new Date();
      setInterval(checkUptimeStats, global.config.erizo.checkUptimeInterval * 1000);
    }
  };


  that.publishers = publishers;
  that.ioThreadPool = io;

  const forEachPublisher = (action) => {
    const publisherStreamIds = Object.keys(publishers);
    for (let i = 0; i < publisherStreamIds.length; i += 1) {
      action(publisherStreamIds[i], publishers[publisherStreamIds[i]]);
    }
  };

  const getOrCreateClient = (clientId, singlePC = false) => {
    log.debug(`getOrCreateClient with id ${clientId}`);
    let client = clients.get(clientId);
    if (client === undefined) {
      client = new Client(clientId, threadPool, ioThreadPool, !!singlePC);
      clients.set(clientId, client);
    }
    return client;
  };

  const onAdaptSchemeNotify = (callbackRpc, type, message) => {
    callbackRpc(type, message);
  };

  const onPeriodicStats = (clientId, streamId, newStats) => {
    const timeStamp = new Date();
    amqper.broadcast('stats', { pub: streamId,
      subs: clientId,
      stats: JSON.parse(newStats),
      timestamp: timeStamp.getTime() });
  };

  const onConnectionStatusEvent = (callbackRpc, clientId, streamId, connectionEvent, newStatus) => {
    if (newStatus && global.config.erizoController.report.connection_events) {
      const timeStamp = new Date();
      amqper.broadcast('event', { pub: streamId,
        subs: clientId,
        type: 'connection_status',
        status: newStatus,
        timestamp: timeStamp.getTime() });
    }
    callbackRpc('callback', connectionEvent);
  };

  const closeNode = (node, sendOffer) => {
    const clientId = node.clientId;
    const connection = node.connection;
    log.debug(`message: closeNode, clientId: ${node.clientId}, streamId: ${node.streamId}`);

    const closePromise = node.close(sendOffer);

    const client = clients.get(clientId);
    if (client === undefined) {
      log.debug('message: trying to close node with no associated client,' +
        `clientId: ${clientId}, streamId: ${node.streamId}`);
      return Promise.resolve();
    }

    const remainingConnections = client.maybeCloseConnection(connection.id);
    if (remainingConnections === 0) {
      log.debug(`message: Removing empty client from list, clientId: ${client.id}`);
      clients.delete(client.id);
    }
    return closePromise;
  };

  that.rovMessage = (args, callback) => {
    replManager.processRpcMessage(args, callback);
  };

  that.addExternalInput = (streamId, url, callbackRpc) => {
    updateUptimeInfo();
    if (publishers[streamId] === undefined) {
      const client = getOrCreateClient(url);
      publishers[streamId] = new ExternalInput(url, streamId, threadPool);
      const ei = publishers[streamId];
      const answer = ei.init();
      // We add the connection manually to the client
      client.addConnection(ei);
      if (answer >= 0) {
        callbackRpc('callback', 'success');
      } else {
        callbackRpc('callback', answer);
      }
    } else {
      log.warn(`message: Publisher already set, code: ${WARN_CONFLICT}, ` +
        `streamId: ${streamId}`);
    }
  };

  that.addExternalOutput = (streamId, url, options) => {
    updateUptimeInfo();
    if (publishers[streamId]) publishers[streamId].addExternalOutput(url, options);
  };

  that.removeExternalOutput = (streamId, url) => {
    if (publishers[streamId] !== undefined) {
      log.info('message: Stopping ExternalOutput, ' +
        `id: ${publishers[streamId].getExternalOutput(url).id}`);
      publishers[streamId].removeExternalOutput(url);
    }
  };

  that.processSignaling = (clientId, streamId, msg) => {
    log.info('message: Process Signaling message, ' +
      `streamId: ${streamId}, clientId: ${clientId}`);
    if (streamId instanceof Array && streamId.length > 0) {
      const streamIds = [];
      let lastSubscriber;
      streamId.forEach((sid) => {
        const publisher = publishers[sid];
        if (publisher.hasSubscriber(clientId)) {
          const subscriber = publisher.getSubscriber(clientId);
          if (subscriber) {
            lastSubscriber = subscriber;
            streamIds.push(subscriber.erizoStreamId);
          }
        }
      });
      if (lastSubscriber) {
        lastSubscriber.onSignalingMessage(msg, streamIds);
      }
    } else if (publishers[streamId] !== undefined) {
      const publisher = publishers[streamId];
      if (publisher.hasSubscriber(clientId)) {
        const subscriber = publisher.getSubscriber(clientId);
        subscriber.onSignalingMessage(msg);
      } else {
        publisher.onSignalingMessage(msg);
      }
    }
  };

  /*
   * Adds a publisher to the room. This creates a new OneToManyProcessor
   * and a new WebRtcConnection. This WebRtcConnection will be the publisher
   * of the OneToManyProcessor.
   */
  that.addPublisher = (clientId, streamId, options, callbackRpc) => {
    updateUptimeInfo();
    let publisher;
    log.info('addPublisher, clientId', clientId, 'streamId', streamId);
    const client = getOrCreateClient(clientId, options.singlePC);

    if (publishers[streamId] === undefined) {
      // eslint-disable-next-line no-param-reassign
      options.publicIP = that.publicIP;
      // eslint-disable-next-line no-param-reassign
      options.privateRegexp = that.privateRegexp;
      const connection = client.getOrCreateConnection(options);
      log.info('message: Adding publisher, ' +
        `clientId: ${clientId}, ` +
        `streamId: ${streamId}`,
        logger.objectToLog(options),
        logger.objectToLog(options.metadata));
      publisher = new Publisher(clientId, streamId, connection, options);
      publishers[streamId] = publisher;
      publisher.initMediaStream();
      publisher.on('callback', onAdaptSchemeNotify.bind(this, callbackRpc));
      publisher.on('periodic_stats', onPeriodicStats.bind(this, streamId, undefined));
      publisher.on('status_event',
        onConnectionStatusEvent.bind(this, callbackRpc, clientId, streamId));
      const isNewConnection = connection.init(streamId);
      if (options.singlePC && !isNewConnection) {
        callbackRpc('callback', { type: 'initializing' });
      }
    } else {
      publisher = publishers[streamId];
      if (publisher.numSubscribers === 0) {
        log.warn('message: publisher already set but no subscribers will ignore, ' +
          `code: ${WARN_CONFLICT}, streamId: ${streamId}`,
          logger.objectToLog(options.metadata));
      } else {
        log.warn('message: publisher already set has subscribers will ignore, ' +
          `code: ${WARN_CONFLICT}, streamId: ${streamId}`);
      }
    }
  };

  /*
   * Adds a subscriber to the room. This creates a new WebRtcConnection.
   * This WebRtcConnection will be added to the subscribers list of the
   * OneToManyProcessor.
   */
  that.addSubscriber = (clientId, streamId, options, callbackRpc) => {
    updateUptimeInfo();
    const publisher = publishers[streamId];
    if (publisher === undefined) {
      log.warn('message: addSubscriber to unknown publisher, ' +
        `code: ${WARN_NOT_FOUND}, streamId: ${streamId}, ` +
        `clientId: ${clientId}`,
        logger.objectToLog(options.metadata));
      // We may need to notify the clients
      return;
    }
    let subscriber = publisher.getSubscriber(clientId);
    const client = getOrCreateClient(clientId, options.singlePC);
    if (subscriber !== undefined) {
      log.warn('message: Duplicated subscription will resubscribe, ' +
        `code: ${WARN_CONFLICT}, streamId: ${streamId}, ` +
        `clientId: ${clientId}`, logger.objectToLog(options.metadata));
      that.removeSubscriber(clientId, streamId);
    }
    // eslint-disable-next-line no-param-reassign
    options.publicIP = that.publicIP;
    // eslint-disable-next-line no-param-reassign
    options.privateRegexp = that.privateRegexp;
    const connection = client.getOrCreateConnection(options);
    // eslint-disable-next-line no-param-reassign
    options.label = publisher.label;
    subscriber = publisher.addSubscriber(clientId, connection, options);
    subscriber.initMediaStream();
    subscriber.on('callback', onAdaptSchemeNotify.bind(this, callbackRpc, 'callback'));
    subscriber.on('periodic_stats', onPeriodicStats.bind(this, clientId, streamId));
    subscriber.on('status_event',
      onConnectionStatusEvent.bind(this, callbackRpc, clientId, streamId));
    const isNewConnection = connection.init(subscriber.erizoStreamId);
    if (options.singlePC && !isNewConnection) {
      callbackRpc('callback', { type: 'initializing' });
    }
  };

  /*
   * Adds multiple subscribers to the room.
   */
  that.addMultipleSubscribers = (clientId, streamIds, options, callbackRpc) => {
    if (!options.singlePC) {
      log.warn('message: addMultipleSubscribers not compatible with no single PC, clientId:', clientId);
    }

    const knownPublishers = streamIds.map(streamId => publishers[streamId])
                                     .filter(pub =>
                                       pub !== undefined &&
                                        !pub.getSubscriber(clientId));
    if (knownPublishers.length === 0) {
      log.warn('message: addMultipleSubscribers to unknown publisher, ' +
        `code: ${WARN_NOT_FOUND}, streamIds: ${streamIds}, ` +
        `clientId: ${clientId}`,
        logger.objectToLog(options.metadata));
      callbackRpc('callback', { type: 'error' });
      return;
    }

    log.debug('message: addMultipleSubscribers to publishers, ' +
        `streamIds: ${knownPublishers}, ` +
        `clientId: ${clientId}`,
        logger.objectToLog(options.metadata));

    const client = getOrCreateClient(clientId, options.singlePC);
    // eslint-disable-next-line no-param-reassign
    options.publicIP = that.publicIP;
    // eslint-disable-next-line no-param-reassign
    options.privateRegexp = that.privateRegexp;
    const connection = client.getOrCreateConnection(options);
    const promises = [];
    knownPublishers.forEach((publisher) => {
      const streamId = publisher.streamId;
      // eslint-disable-next-line no-param-reassign
      options.label = publisher.label;
      const subscriber = publisher.addSubscriber(clientId, connection, options);
      subscriber.initMediaStream(true);
      subscriber.copySdpInfoFromPublisher();
      promises.push(subscriber.promise);
      subscriber.on('callback', onAdaptSchemeNotify.bind(this, callbackRpc, 'callback'));
      subscriber.on('periodic_stats', onPeriodicStats.bind(this, clientId, streamId));
      subscriber.on('status_event',
        onConnectionStatusEvent.bind(this, callbackRpc, clientId, streamId));
    });

    const knownStreamIds = knownPublishers.map(pub => pub.streamId);

    const constraints = {
      audio: true,
      video: true,
      bundle: true,
    };

    connection.init(knownStreamIds[0], constraints);
    promises.push(connection.createOfferPromise);
    Promise.all(promises)
      .then(() => {
        log.debug('message: autoSubscription waiting for gathering event', connection.alreadyGathered, connection.gatheredPromise);
        return connection.gatheredPromise;
      })
      .then(() => {
        callbackRpc('callback', { type: 'multiple-initializing', streamIds: knownStreamIds, context: 'auto-streams-subscription', options });
        const evt = connection.createOffer();
        evt.streamIds = knownStreamIds;
        evt.options = options;
        evt.context = 'auto-streams-subscription';
        log.debug(`message: autoSubscription sending event, type: ${evt.type}, streamId: ${knownStreamIds}, sessionVersion: ${connection.sessionVersion}, sdp: ${evt.sdp}`);
        callbackRpc('callback', evt);
      });
  };

    /*
   * Removes multiple subscribers from the room.
   */
  that.removeMultipleSubscribers = (clientId, streamIds, callbackRpc) => {
    const knownPublishers = streamIds.map(streamId => publishers[streamId])
                                     .filter(pub =>
                                       pub !== undefined &&
                                        pub.getSubscriber(clientId));
    if (knownPublishers.length === 0) {
      log.warn('message: removeMultipleSubscribers from unknown publisher, ' +
        `code: ${WARN_NOT_FOUND}, streamIds: ${streamIds}, ` +
        `clientId: ${clientId}`);
      callbackRpc('callback', { type: 'error' });
      return;
    }

    log.debug('message: removeMultipleSubscribers from publishers, ' +
        `streamIds: ${knownPublishers}, ` +
        `clientId: ${clientId}`);

    const client = clients.get(clientId);
    if (!client) {
      callbackRpc('callback', { type: 'error' });
    }

    let connection;

    const promises = [];
    knownPublishers.forEach((publisher) => {
      if (publisher && publisher.hasSubscriber(clientId)) {
        const subscriber = publisher.getSubscriber(clientId);
        connection = subscriber.connection;
        promises.push(closeNode(subscriber, false));
        publisher.removeSubscriber(clientId);
      }
    });

    const knownStreamIds = knownPublishers.map(pub => pub.streamId);

    Promise.all(promises)
      .then(() => {
        log.warn('message: removeMultipleSubscribers waiting for gathering event', connection.alreadyGathered, connection.gatheredPromise);
        return connection.gatheredPromise;
      })
      .then(() => {
        const evt = connection.createOffer();
        evt.streamIds = knownStreamIds;
        evt.context = 'auto-streams-unsubscription';
        log.warn(`message: removeMultipleSubscribers sending event, type: ${evt.type}, streamId: ${knownStreamIds}, sessionVersion: ${connection.sessionVersion}, sdp: ${evt.sdp}`);
        callbackRpc('callback', evt);
      });
  };

  /*
   * Removes a publisher from the room. This also deletes the associated OneToManyProcessor.
   */
  that.removePublisher = (clientId, streamId, callback = () => {}) =>
    new Promise((resolve) => {
      const publisher = publishers[streamId];
      if (publisher !== undefined) {
        log.info(`message: Removing publisher, id: ${clientId}, streamId: ${streamId}`);
        publisher.forEachSubscriber((subscriberId, subscriber) => {
          log.info(`message: Removing subscriber, id: ${subscriberId}`);
          closeNode(subscriber);
          publisher.removeSubscriber(subscriberId);
        });
        publisher.removeExternalOutputs().then(() => {
          closeNode(publisher);
          delete publishers[streamId];
          publisher.muxer.close((message) => {
            log.info('message: muxer closed succesfully, ' +
              `id: ${streamId}`,
              logger.objectToLog(message));
            const count = Object.keys(publishers).length;
            log.debug(`message: remaining publishers, publisherCount: ${count}`);
            callback('callback', true);
            resolve();
            if (count === 0) {
              log.info('message: Removed all publishers. Killing process.');
              process.exit(0);
            }
          });
        });
      } else {
        log.warn('message: removePublisher that does not exist, ' +
          `code: ${WARN_NOT_FOUND}, id: ${streamId}`);
        resolve();
      }
    });

  /*
   * Removes a subscriber from the room.
   * This also removes it from the associated OneToManyProcessor.
   */
  that.removeSubscriber = (clientId, streamId, callback = () => {}) => {
    const publisher = publishers[streamId];
    if (publisher && publisher.hasSubscriber(clientId)) {
      const subscriber = publisher.getSubscriber(clientId);
      log.info(`message: removing subscriber, streamId: ${subscriber.streamId}, ` +
        `clientId: ${clientId}`);
      return closeNode(subscriber).then(() => {
        publisher.removeSubscriber(clientId);
        log.info(`message: subscriber node Closed, streamId: ${subscriber.streamId}`);
        callback('callback', true);
      });
    }
    log.warn(`message: removeSubscriber no publisher has this subscriber, clientId: ${clientId}, streamId: ${streamId}`);
    callback('callback', true);
    return Promise.resolve();
  };

  /*
   * Removes all the subscribers related with a client.
   */
  that.removeSubscriptions = (clientId) => {
    log.info('message: removing subscriptions, clientId:', clientId);
    // we go through all the connections in the client and we close them
    forEachPublisher((publisherId, publisher) => {
      const subscriber = publisher.getSubscriber(clientId);
      if (subscriber) {
        log.debug('message: removing subscription, ' +
          'id:', subscriber.clientId);
        closeNode(subscriber);
        publisher.removeSubscriber(clientId);
      }
    });
  };

  that.getStreamStats = (streamId, callbackRpc) => {
    const stats = {};
    let publisher;
    log.debug(`message: Requested stream stats, streamID: ${streamId}`);
    const promises = [];
    if (streamId && publishers[streamId]) {
      publisher = publishers[streamId];
      promises.push(publisher.getStats('publisher', stats));

      publisher.forEachSubscriber((subscriberId, subscriber) => {
        promises.push(
          subscriber.getStats(
            subscriberId,
            stats));
      });
      Promise.all(promises).then(() => {
        callbackRpc('callback', stats);
      });
    }
  };

  that.subscribeToStats = (streamId, timeout, interval, callbackRpc) => {
    let publisher;
    log.debug(`message: Requested subscription to stream stats, streamId: ${streamId}`);

    if (streamId && publishers[streamId]) {
      publisher = publishers[streamId];

      if (global.config.erizoController.reportSubscriptions &&
          global.config.erizoController.reportSubscriptions.maxSubscriptions > 0) {
        if (timeout > global.config.erizoController.reportSubscriptions.maxTimeout) {
          // eslint-disable-next-line no-param-reassign
          timeout = global.config.erizoController.reportSubscriptions.maxTimeout;
        }
        if (interval < global.config.erizoController.reportSubscriptions.minInterval) {
          // eslint-disable-next-line no-param-reassign
          interval = global.config.erizoController.reportSubscriptions.minInterval;
        }
        if (statsSubscriptions[streamId]) {
          log.debug(`message: Renewing subscription to stream: ${streamId}`);
          clearTimeout(statsSubscriptions[streamId].timeout);
          clearInterval(statsSubscriptions[streamId].interval);
        } else if (Object.keys(statsSubscriptions).length <
            global.config.erizoController.reportSubscriptions.maxSubscriptions) {
          statsSubscriptions[streamId] = {};
        }

        if (!statsSubscriptions[streamId]) {
          log.debug('message: Max Subscriptions limit reached, ignoring message');
          return;
        }

        statsSubscriptions[streamId].interval = setInterval(() => {
          const promises = [];
          const stats = {};

          stats.streamId = streamId;
          promises.push(publisher.getStats('publisher', stats));
          publisher.forEachSubscriber((subscriberId, subscriber) => {
            promises.push(subscriber.getStats(subscriberId, stats));
          });
          Promise.all(promises).then(() => {
            amqper.broadcast('stats_subscriptions', stats);
          });
        }, interval * 1000);

        statsSubscriptions[streamId].timeout = setTimeout(() => {
          clearInterval(statsSubscriptions[streamId].interval);
          delete statsSubscriptions[streamId];
        }, timeout * 1000);

        callbackRpc('success');
      } else {
        log.debug('message: Report subscriptions disabled by config, ignoring message');
      }
    } else {
      log.debug(`message: stream not found - ignoring message, streamId: ${streamId}`);
    }
  };

  return that;
};
