
import * as util from 'util';
import * as https from 'https';
import * as querystring from 'querystring';
import * as uuid from 'uuid';
import Errors from './Errors';

const debugLog = util.debuglog('vk-sdk'),
    defaultRequestOptions = {
        timeout: 60000,
        gzip: true,
    },
    successStatusCodes = new Set([200, 201, 202, 204, 304]),
    log = debugLog.bind(debugLog, 'Request: ');

export default class Request {
    private static headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-agent': 'nodejs',
    };
    private static minRequestsInterval = 1000 / 3; // max 3 requests in sec

    private method: string;
    private sdk: any;
    private requestId = uuid.v4();
    private body = {};
    private bodyDefault = {};
    private checkStatusCode = true;
    private cachedSendPromise: Promise<object>;

    constructor(method: string, sdk: any) {
        this.method = method;
        this.sdk = sdk;
        this.bodyDefault = {
            lang: this.sdk.options.language,
            v: this.sdk.options.version,
            https: (this.sdk.options.https) ? 1 : 0,
        };
    }

    public setBody(body: object) {
        this.body = body;

        return this;
    }

    public then() {
        this.cachedSendPromise = this.cachedSendPromise || this.send();

        return this.cachedSendPromise.then(...arguments);
    }

    public catch() {
        this.cachedSendPromise = this.cachedSendPromise || this.send();

        return this.cachedSendPromise.catch(...arguments);
    }

    public send() {
        const authData: any = {};

        if (this.sdk.options.secure) {
            if (this.sdk.token) {
                authData.access_token = this.sdk.token;
            }

            if (this.sdk.options.appSecret) {
                authData.client_secret = this.sdk.options.appSecret;
            }
        }

        const bodyObj = Object.assign(
                {},
                this.bodyDefault,
                authData,
                this.body,
            ),
            body = querystring.stringify(bodyObj),
            headers = Object.assign({}, Request.headers, {'Content-Length': Buffer.byteLength(body)}),
            requestOptions = Object.assign({}, defaultRequestOptions, {
                host: 'api.vk.com',
                port: 443,
                path: '/method/' + this.method,
                method: 'POST',
                headers,
            });

        log(`(${this.requestId}) Request.send: request with body:`, bodyObj);
        log(`(${this.requestId}) Request.send: request with params:`, requestOptions);

        return new Promise((resolve, reject) => {
            this.waitForNextRequest(() => {
                this.sdk.requestingNow = true;

                const req = https.request(requestOptions, (res) => {
                    const apiResponse: any = [];

                    res.setEncoding('utf8');

                    res.on('data', (chunk) => {
                        apiResponse.push(chunk);
                    });

                    res.on('end', () => {
                        this.sdk.reqLastTime = Date.now();
                        this.sdk.requestingNow = false;

                        let resJSON;

                        try {
                            resJSON = JSON.parse(apiResponse.join(''));
                        } catch (err) {
                            err.res = {requestId: this.requestId};

                            reject(err);
                        }

                        log(`(${this.requestId}) Request.send: response statusCode:`, res.statusCode);
                        log(`(${this.requestId}) Request.send: response headers:`, res.headers);

                        if (this.checkStatusCode && !successStatusCodes.has(res.statusCode as number)) {
                            const invalidStatusCodeError = new Errors.InvalidStatusCodeError();

                            invalidStatusCodeError.resJSON = resJSON;
                            invalidStatusCodeError.res = res;

                            return reject(invalidStatusCodeError);
                        }

                        resolve(resJSON);
                    });
                }).on('error', (err: any) => {
                    this.sdk.requestingNow = false;

                    err.res = {requestId: this.requestId};

                    reject(err);
                });

                req.write(body);
                req.end();
            });
        });
    }

    private isRequestsLimitPassed() {
        return Date.now() - this.sdk.reqLastTime > Request.minRequestsInterval && !this.sdk.requestingNow;
    }

    private waitForNextRequest(cb: (...args: any[]) => any) {
        if (this.isRequestsLimitPassed()) {
            cb();
        } else {
            setTimeout(() => {
                this.waitForNextRequest(cb);
            }, 50);
        }
    }
}