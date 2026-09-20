// A model that never generates anything. Lets an agent start without any API key so that commands can be
// driven from outside (scripts/run_command.js, integration tests). Select it with `"model": "none"`.
export class NoModel {
    static prefix = 'none';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = url;
        this.params = params;
    }

    async sendRequest(_turns, _systemMessage) {
        return '';
    }

    async sendVisionRequest(_turns, _systemMessage, _imageBuffer) {
        return '';
    }

    async embed(_text) {
        // callers catch this and fall back to word-overlap similarity
        throw new Error('The "none" model has no embeddings.');
    }
}
