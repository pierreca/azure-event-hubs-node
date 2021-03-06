// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as chai from "chai";
const should = chai.should();
import * as chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);
import * as debugModule from "debug";
const debug = debugModule("azure:event-hubs:misc-spec");
import { EventPosition, EventHubClient, EventData, EventHubRuntimeInformation } from "../lib";
import { BatchingReceiver } from "../lib/batchingReceiver";

describe("Misc tests", function () {
  this.timeout(60000);
  const service = { connectionString: process.env.EVENTHUB_CONNECTION_STRING, path: process.env.EVENTHUB_NAME };
  let client: EventHubClient = EventHubClient.createFromConnectionString(service.connectionString!, service.path);
  let breceiver: BatchingReceiver;
  let hubInfo: EventHubRuntimeInformation;
  before("validate environment", async function () {
    should.exist(process.env.EVENTHUB_CONNECTION_STRING,
      "define EVENTHUB_CONNECTION_STRING in your environment before running integration tests.");
    should.exist(process.env.EVENTHUB_NAME,
      "define EVENTHUB_NAME in your environment before running integration tests.");
    hubInfo = await client.getHubRuntimeInformation();
  });

  after("close the connection", async function () {
    await client.close();
  });

  it("should be able to send and receive a large message correctly", async function () {
    const bodysize = 220 * 1024;
    const partitionId = hubInfo.partitionIds[0];
    const msgString = "A".repeat(220 * 1024);
    const msgBody = Buffer.from(msgString);
    const obj: EventData = { body: msgBody };
    debug("Sending one message with %d bytes.", bodysize);
    breceiver = BatchingReceiver.create((client as any)._context, partitionId, { eventPosition: EventPosition.fromEnqueuedTime(Date.now()) });
    let datas = await breceiver.receive(5, 5);
    datas.length.should.equal(0);
    await client.send(obj, partitionId);
    debug("Successfully sent the large message.");
    datas = await breceiver.receive(5, 10);
    debug("received message: ", datas);
    should.exist(datas);
    datas.length.should.equal(1);
    datas[0].body.toString().should.equal(msgString);
  });

  it("should be able to send and receive batched messages correctly", async function () {
    try {
      const partitionId = hubInfo.partitionIds[0];
      breceiver = BatchingReceiver.create((client as any)._context, partitionId, { eventPosition: EventPosition.fromEnqueuedTime(Date.now()) });
      let datas = await breceiver.receive(5, 10);
      datas.length.should.equal(0);
      const messageCount = 5;
      let d: EventData[] = [];
      for (let i = 0; i < messageCount; i++) {
        let obj: EventData = { body: `Hello EH ${i}` };
        d.push(obj);
      }
      d[0].partitionKey = 'pk1234656';

      await client.sendBatch(d, partitionId);
      debug("Successfully sent 5 messages batched together.");
      datas = await breceiver.receive(5, 10);
      debug("received message: ", datas);
      should.exist(datas);
      datas.length.should.equal(5);
    } catch (err) {
      debug("should not have happened, uber catch....", err);
      throw err;
    }
  });

  it("should consistently send messages with partitionkey to a partitionId", async function () {
    const msgToSendCount = 50;
    let partitionOffsets = {};
    debug("Discovering end of stream on each partition.");
    const partitionIds = hubInfo.partitionIds;
    for (let id of partitionIds) {
      const pInfo = await client.getPartitionInformation(id);
      partitionOffsets[id] = pInfo.lastEnqueuedOffset;
      debug(`Partition ${id} has last message with offset ${pInfo.lastEnqueuedOffset}.`);
    }
    debug("Sending %d messages.", msgToSendCount);
    function getRandomInt(max) {
      return Math.floor(Math.random() * Math.floor(max));
    }
    for (let i = 0; i < msgToSendCount; i++) {
      const partitionKey = getRandomInt(10);
      await client.send({ body: "Hello EventHub " + i, partitionKey: partitionKey.toString() });
    }
    debug("Starting to receive all messages from each partition.");
    let partitionMap = {};
    let totalReceived = 0;
    for (let id of partitionIds) {
      let datas = await client.receiveBatch(id, 50, 10, { eventPosition: EventPosition.fromOffset(partitionOffsets[id]) });
      debug(`Received ${datas.length} messages from partition ${id}.`);
      for (let d of datas) {
        debug(">>>> _raw_amqp_mesage: ", d._raw_amqp_mesage)
        const pk = d.partitionKey as string;
        debug("pk: ", pk);
        if (partitionMap[pk] && partitionMap[pk] !== id) {
          debug(`#### Error: Received a message from partition ${id} with partition key ${pk}, whereas the same key was observed on partition ${partitionMap[pk]} before.`);
        }
        partitionMap[pk] = id;
        debug("partitionMap ", partitionMap);
      }
      totalReceived += datas.length;
    }
    totalReceived.should.equal(msgToSendCount);
  });
});
