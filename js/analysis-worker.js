import { analyzeAudio, AnalysisError } from './analysis.js';

self.onmessage = (event) => {
  const { samples, sampleRate } = event.data;
  try {
    const result = analyzeAudio(samples, sampleRate, (fraction, label) => self.postMessage({ type: 'progress', fraction, label }));
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({ type: 'error', code: error instanceof AnalysisError ? error.code : 'internal', message: error.message });
  }
};
