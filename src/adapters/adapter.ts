//
// Copyright (C) Microsoft. All rights reserved.
//

import * as request from 'request';
import * as http from 'http';
import * as WebSocket from 'ws';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { ITarget, IAdapterOptions } from './adapterInterfaces';
import { Target } from '../protocols/target';
import { Logger } from '../logger';

export class Adapter extends EventEmitter {
    protected _id: string;
    protected _adapterType: string;
    protected _proxyUrl: string;
    protected _options: IAdapterOptions;
    protected _url: string;
    protected _proxyProc: ChildProcess;
    protected _targetMap: Map<string, Target>;
    protected _targetIdToTargetDataMap: Map<string, ITarget>;

    constructor(id: string, socket: string, options: IAdapterOptions) {
        super();

        this._id = id;
        this._proxyUrl = socket;
        this._targetMap = new Map<string, Target>();
        this._targetIdToTargetDataMap = new Map<string, ITarget>();

        // Apply default options
        options.pollingInterval = options.pollingInterval || 3000;
        options.baseUrl = options.baseUrl || 'http://127.0.0.1';
        options.path = options.path || '/json';
        options.port = options.port || 9222;
        this._options = options;

        this._url = `${this._options.baseUrl}:${this._options.port}${this._options.path}`;

        const index = this._id.indexOf('/', 1);
        if (index >= 0) {
            this._adapterType = '_' + this._id.substr(1, index - 1);
        } else {
            this._adapterType = this._id.replace('/', '_');
        }
    }

    public get id(): string {
        return this._id;
    }

    public start(): void {
        Logger.log('adapter.start');
        if (this._options.proxyExePath) {
            // Start the Proxy
            this.spawnProcess(this._options.proxyExePath, this._options.proxyExeArgs);
        }
    }

    public stop(): void {
        if (this._proxyProc) {
            // Terminate the proxy process
            this._proxyProc.kill('SIGTERM');
            this._proxyProc = null;
        }
    }

    public getTargets(metadata?: any): Promise<ITarget[]> {
        return new Promise((resolve, reject) => {
            request(this._url, (error: any, response: http.IncomingMessage, body: any) => {
                if (error) {
                    resolve([]);
                    return;
                }

                const targets: ITarget[] = [];
                const rawTargets: ITarget[] = JSON.parse(body);
                rawTargets.forEach((t: ITarget) => {
                    targets.push(this.setTargetInfo(t, metadata));
                });

                resolve(targets);
            });
        });
    }

    public connectTo(targetId: string, wsFrom: WebSocket): Target {
        if (!this._targetIdToTargetDataMap.has(targetId)) {
            Logger.error(`No endpoint url found for id ${targetId}`);
            return null;
        } else if (this._targetMap.has(targetId)) {
            Logger.log(`Existing target found for id ${targetId}`);
            const target = this._targetMap.get(targetId);
            target.updateClient(wsFrom);
            return target;
        }

        const targetData = this._targetIdToTargetDataMap.get(targetId);
        const target = new Target(targetId, targetData);
        target.connectTo(targetData.webSocketDebuggerUrl, wsFrom);

        // Store the tools websocket for this target
        this._targetMap.set(targetId, target);
        target.on('socketClosed', (id) => {
            this.emit('socketClosed', id);
        });

        return target;
    }

    public forwardTo(targetId: string, message: string): void {
        if (!this._targetMap.has(targetId)) {
            Logger.error(`No target found for id ${targetId}`);
            return;
        }

        this._targetMap.get(targetId).forward(message);
    }

    public forceRefresh() {
        if (this._proxyProc && this._options.proxyExePath && this._options.proxyExeArgs) {
            this.refereshProcess(this._proxyProc, this._options.proxyExePath, this._options.proxyExeArgs);
        }
    }

    protected setTargetInfo(t: ITarget, metadata?: any): ITarget {
        // Ensure there is a valid id
        const id: string = (t.id || t.appId);
        t.id = id;

        // Set the adapter type
        t.adapterType = this._adapterType;
        t.type = t.type || 'page';

        // Append the metadata
        t.metadata = metadata;

        // Store the real endpoint
        const targetData = JSON.parse(JSON.stringify(t));
        this._targetIdToTargetDataMap.set(t.id, targetData);

        // Overwrite the real endpoint with the url of our proxy multiplexor
        t.webSocketDebuggerUrl = `${this._proxyUrl}${this._id}/${t.id}`;
        let wsUrl = `${this._proxyUrl.replace('ws://', '')}${this._id}/${t.id}`;
        t.devtoolsFrontendUrl = `https://chrome-devtools-frontend.appspot.com/serve_file/@60cd6e859b9f557d2312f5bf532f6aec5f284980/inspector.html?experiments=true&ws=${wsUrl}`;

        return t;
    }

    protected refereshProcess(process: ChildProcess, path: string, args: string[]) {
        process.kill('SIGTERM');
        this.spawnProcess(path, args);
    }

    protected spawnProcess(path: string, args: string[]): ChildProcess {
        if (!this._proxyProc) {
            this._proxyProc = spawn(path, args, {
                detached: true,
                stdio: ['ignore']
            });
            this._proxyProc.on('error', (err) => {
                this.stop();
            });
        }

        return this._proxyProc;
    }
}
