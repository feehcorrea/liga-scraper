// Baixa o modelo SigLIP durante o build do Docker (evita download a cada boot)
import { AutoProcessor, SiglipVisionModel } from '@huggingface/transformers'

const MODEL = 'Xenova/siglip-base-patch16-224'
console.log('Baixando', MODEL, '...')
await AutoProcessor.from_pretrained(MODEL)
await SiglipVisionModel.from_pretrained(MODEL, { dtype: 'q8' })
console.log('Modelo em cache para runtime.')
