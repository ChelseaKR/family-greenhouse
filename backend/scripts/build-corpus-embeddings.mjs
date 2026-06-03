/**
 * One-shot script that turns the markdown corpus in
 * `src/data/plant-care-corpus/*.md` into a JSON file of pre-computed
 * embeddings shipped inside the Lambda bundle.
 *
 * Why bundle vs DDB:
 *   - Corpus is small (<60 chunks), so loading 200 KB JSON at cold start
 *     beats a DDB Query per chat turn on latency.
 *   - Updating the corpus means committing both the .md AND the .json,
 *     which is also a deploy gate — desired (you wouldn't want a
 *     mid-conversation corpus swap anyway).
 *
 * Usage:
 *   AWS_PROFILE=family-greenhouse AWS_REGION=us-east-1 \
 *     node scripts/build-corpus-embeddings.mjs
 *
 * Output: src/data/plant-care-corpus-embeddings.json
 * Cost:   ~$0.0002 per full corpus rebuild at Titan v2 list pricing.
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, '..', 'src', 'data', 'plant-care-corpus');
const OUTPUT_FILE = join(__dirname, '..', 'src', 'data', 'plant-care-corpus-embeddings.json');

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const EMBED_MODEL = process.env.BEDROCK_EMBED_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 1024;

const client = new BedrockRuntimeClient({ region: REGION });

/**
 * Split a markdown file into chunks. Strategy:
 *   - Each `## H2` opens a new chunk; the chunk includes everything up to
 *     the next H2 or EOF.
 *   - The H1 title becomes the chunk's `title` metadata so retrieval can
 *     surface "from <article>: <section>".
 *
 * No fancy semantic chunking — these articles are already hand-written
 * to be section-coherent. Keeping it dumb keeps it predictable.
 */
function chunkMarkdown(source, content) {
  const lines = content.split('\n');
  const h1 = lines.find((l) => l.startsWith('# ')) ?? '';
  const articleTitle = h1.replace(/^#\s+/, '').trim();

  const chunks = [];
  let currentSectionTitle = articleTitle;
  let currentLines = [];

  function flush() {
    const text = currentLines.join('\n').trim();
    if (text.length < 80) return; // too short to be useful
    chunks.push({
      source,
      articleTitle,
      sectionTitle: currentSectionTitle,
      text,
    });
  }

  for (const line of lines) {
    if (line.startsWith('# ')) continue; // top-level title, kept as articleTitle
    if (line.startsWith('## ')) {
      flush();
      currentSectionTitle = line.replace(/^##\s+/, '').trim();
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  flush();
  return chunks;
}

async function embed(text) {
  const command = new InvokeModelCommand({
    modelId: EMBED_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inputText: text,
      dimensions: DIMENSIONS,
      normalize: true,
    }),
  });
  const result = await client.send(command);
  const decoded = JSON.parse(new TextDecoder().decode(result.body));
  if (!Array.isArray(decoded.embedding) || decoded.embedding.length !== DIMENSIONS) {
    throw new Error(`Unexpected embed response: ${JSON.stringify(decoded).slice(0, 200)}`);
  }
  return decoded.embedding;
}

async function main() {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md'));
  console.log(`Reading ${files.length} markdown files from ${CORPUS_DIR}`);

  const allChunks = [];
  for (const file of files) {
    const content = readFileSync(join(CORPUS_DIR, file), 'utf8');
    const chunks = chunkMarkdown(file, content);
    console.log(`  ${file}: ${chunks.length} chunks`);
    allChunks.push(...chunks);
  }
  console.log(`Total ${allChunks.length} chunks. Embedding via ${EMBED_MODEL}...`);

  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const embedInput = `${chunk.articleTitle}\n${chunk.sectionTitle}\n\n${chunk.text}`;
    chunk.embedding = await embed(embedInput);
    process.stdout.write(`\r  embedded ${i + 1}/${allChunks.length}`);
  }
  console.log('');

  const payload = {
    model: EMBED_MODEL,
    dimensions: DIMENSIONS,
    generatedAt: new Date().toISOString(),
    chunks: allChunks,
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(payload));
  const sizeKb = (JSON.stringify(payload).length / 1024).toFixed(1);
  console.log(`Wrote ${OUTPUT_FILE} (${sizeKb} KB, ${allChunks.length} chunks)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
