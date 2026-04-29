/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { invoke } = window.__TAURI__.tauri;

async function testEmbeddings() {
  try {
    // First initialize the embedder
    await invoke('init_embedder');
    console.log('Embedder initialized successfully');
    
    // Test with a small list of texts
    const texts = [
      "Hello world",
      "This is a test",
      "Generate embeddings for these texts"
    ];
    
    console.log('Generating embeddings for:', texts);
    const embeddings = await invoke('generate_embeddings', { texts });
    
    console.log('Generated embeddings:', embeddings);
    console.log('Number of embeddings:', embeddings.length);
    console.log('Embedding dimensions:', embeddings[0].length);
    
    // Test completed successfully
    console.log('Test completed successfully!');
  } catch (error) {
    console.error('Error during test:', error);
  }
}

// Run the test
testEmbeddings();