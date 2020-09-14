const superagent = require('superagent');
const flags = require('flags');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

flags.defineString('repository', undefined, 'Insert Repository to be deleted');
flags.defineInteger('keep', 5, 'Max # of images to keep');

flags.parse();

let repoUrlStr = flags.get('repository');
if (repoUrlStr === undefined) {
    throw Error('Repository must not be null.');
}
const repoUrl = new URL(`https://${repoUrlStr}`);
if (!repoUrl.hostname) throw Error('Repository Url hostname not found.');
switch (repoUrl.hostname) {
    case 'gcr.io':
    case 'us.gcr.io':
    case 'eu.gcr.io':
    case 'asia.gcr.io':
        break;
    default:
        throw Error('Repository one of [gcr.io, us.gcr.io, eu.gcr.io, asia.gcr.io].');
}

let keep = flags.get('keep');
if (keep <= 0) throw Error('Keep must be unsigned.');

async function gcloudToken() {
    const {stdout, stderr} = await exec('gcloud auth print-access-token');
    if (stderr) {
        throw Error(stderr);
    }
    return stdout.replace('\n', '');
}

async function deleteOldBuilds(manifest, registryAccessToken) {
    manifest.sort((a, b) => {
        if (a.timeUploadedMs > b.timeUploadedMs) {
            return -1;
        }
        if (a.timeUploadedMs < b.timeUploadedMs) {
            return 1;
        }
        return 0;
    });
    if (keep >= manifest.length) {
        console.log('There is no images to delete. manifest length: ', manifest.length);
        return [];
    }
    let deleteReqs = [];
    let requestQueue = [];
    for (let i = keep; i < manifest.length; i++) {
        requestQueue.push(
            superagent
                .delete(`${repoUrl.origin}/v2${repoUrl.pathname}/manifests/${manifest[i].key}`)
                .auth(registryAccessToken, {type: 'bearer'}).then(res => ({image: `${repoUrl.hostname}${repoUrl.pathname}@${manifest[i].key}`, status: res.status})).catch(err => {
                return {image: `${repoUrl.hostname}${repoUrl.pathname}@${manifest[i].key}`, status: err.status, reason: 'status: '+ err.status + ', body: ' +JSON.stringify(err.response.body)}
            })
        );
        if(requestQueue.length === 3) {
            deleteReqs.push(...await Promise.all(requestQueue));
            requestQueue = [];
        }
    }
    if(requestQueue.length > 0) {
        deleteReqs.push(...await Promise.all(requestQueue));
    }
    return deleteReqs;
}

async function main() {
    const googleAccessToken = await gcloudToken();
    const tokenRes = await superagent.get(`${repoUrl.origin}/v2/token`)
        .auth(googleAccessToken, {type: 'bearer'})
        .accept('json')
        .query({scope: `repository:${repoUrl.pathname.substring(1)}:push,pull`, service: repoUrl.hostname});
    const registryAccessToken = tokenRes.body.token;

    const tagListRes = await superagent.get(`${repoUrl.origin}/v2${repoUrl.pathname}/tags/list`)
        .query({n: 99})
        .auth(registryAccessToken, {type: 'bearer'})
        .accept('json');

    const tagList = tagListRes.body;

    let manifestArr = [];
    for (let key of Object.keys(tagList.manifest)) {
        manifestArr.push({key: key, ...tagList.manifest[key]});
    }
    const imageResults = await deleteOldBuilds(manifestArr, registryAccessToken);
    console.log('Success Deleted Images:', imageResults.filter(value => value.status === 202).map(value => value.image));
    const failedImages = imageResults.filter(value => value.status !== 202);
    if(failedImages.length>0) {
        console.log('Failed Deleted Images:', failedImages);
    }
}

main();
