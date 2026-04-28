import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const modelsDir = path.join(__dirname, 'public/assets/models');
const targetFile = path.join(__dirname, 'public/widget-main.js');

console.log('Embedding models from:', modelsDir);

try {
    const models = [];
    for (let i = 1; i <= 7; i++) {
        const filename = `model_${i}.jpg`;
        const filePath = path.join(modelsDir, filename);

        if (fs.existsSync(filePath)) {
            const buffer = fs.readFileSync(filePath);
            const base64 = buffer.toString('base64');
            models.push({
                id: `model_${i}`,
                name: `Model ${i}`,
                // Keep URL as a fallback or reference
                url: `assets/models/${filename}`,
                // The critical Base64 string
                base64: `data:image/jpeg;base64,${base64}`
            });
            console.log(`Processed ${filename}`);
        } else {
            console.warn(`Warning: ${filename} not found`);
        }
    }

    const newContentDef = `const SAMPLE_MODELS = ${JSON.stringify(models, null, 4)};`;

    let jsContent = fs.readFileSync(targetFile, 'utf8');

    // Regex to replace the existing const SAMPLE_MODELS = [...];
    // Matches "const SAMPLE_MODELS = [" followed by anything until "];"
    const regex = /const SAMPLE_MODELS = \[\s*([\s\S]*?)\];/;

    if (regex.test(jsContent)) {
        jsContent = jsContent.replace(regex, newContentDef);
        fs.writeFileSync(targetFile, jsContent, 'utf8');
        console.log('✅ Successfully embedded base64 models into widget-main.js');
    } else {
        console.error('❌ Could not find SAMPLE_MODELS definition in widget-main.js');
        process.exit(1);
    }

} catch (err) {
    console.error('Error:', err);
    process.exit(1);
}
