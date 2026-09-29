#!/usr/bin/python3
"""Inspect projected thread metadata from one disposable Orbit gate."""

import asyncio
import json
import sys

import websockets


async def main():
    socket, thread_id = sys.argv[1:]
    async with websockets.unix_connect(socket, uri="ws://localhost/rpc",
                                      compression=None) as connection:
        await connection.send(json.dumps({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "orbit_fixture_metadata", "title": "Orbit fixture metadata",
                           "version": "1"}, "capabilities": {"experimentalApi": True}}}))
        while True:
            initialized = json.loads(await asyncio.wait_for(connection.recv(), 6))
            if initialized.get("id") != 1:
                continue
            if initialized.get("error"):
                raise RuntimeError("Gate initialize failed: " + json.dumps(initialized["error"]))
            break
        await connection.send(json.dumps({"method": "initialized", "params": {}}))
        await connection.send(json.dumps({"id": 2, "method": "thread/read", "params": {
            "threadId": thread_id, "includeTurns": False, "readOnly": True}}))
        while True:
            response = json.loads(await asyncio.wait_for(connection.recv(), 6))
            if response.get("id") != 2:
                continue
            if response.get("error"):
                raise RuntimeError("Projected metadata request failed: " + json.dumps(response["error"]))
            thread = response["result"]["thread"]
            print(json.dumps({"projectId": thread.get("projectId"), "cwd": thread.get("cwd"),
                              "name": thread.get("name"), "historyMode": thread.get("historyMode"),
                              "path": thread.get("path")}, separators=(",", ":")))
            return


if __name__ == "__main__":
    asyncio.run(main())
