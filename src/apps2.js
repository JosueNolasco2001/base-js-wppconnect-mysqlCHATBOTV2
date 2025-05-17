// Mejora en el manejo del menú del día y solución para usuarios concurrentes
import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, utils, EVENTS } from '@builderbot/bot'
import { MysqlAdapter as Database } from '@builderbot/database-mysql'
import { WPPConnectProvider as Provider } from '@builderbot/provider-wppconnect'
import axios from 'axios'
import { idleFlow, start, reset, stop } from './idle-custom.js'

import fs from 'fs'
import path from 'path'

// Configuración
const IMAGE_CACHE_DIR = './.tmp_images'
const IMAGE_TIMEOUT_MS = 15000 // Reducido a 15 segundos para evitar bloqueos
const CONCURRENT_DOWNLOADS = 3 // Limitar descargas simultáneas
const PORT = process.env.PORT ?? 3008

// Crear directorio temporal si no existe
if (!fs.existsSync(IMAGE_CACHE_DIR)) {
    fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true })
}

// Semáforo simple para limitar descargas concurrentes
class Semaphore {
    constructor(max) {
        this.max = max
        this.count = 0
        this.waiting = []
    }

    async acquire() {
        if (this.count < this.max) {
            this.count++
            return Promise.resolve()
        }

        return new Promise(resolve => {
            this.waiting.push(resolve)
        })
    }

    release() {
        this.count--
        if (this.waiting.length > 0 && this.count < this.max) {
            this.count++
            const next = this.waiting.shift()
            next()
        }
    }
}

const downloadSemaphore = new Semaphore(CONCURRENT_DOWNLOADS)
// Función mejorada para descargar imágenes con control de concurrencia y mejor manejo de errores
const downloadImage = async (url, filename) => {
    await downloadSemaphore.acquire()
    const filePath = path.join(IMAGE_CACHE_DIR, filename)
    
    try {
        // Verificar si la imagen ya existe en caché
        if (fs.existsSync(filePath)) {
            // Verificar cuándo se creó el archivo
            const stats = fs.statSync(filePath)
            const fileAgeMs = Date.now() - stats.mtimeMs
            
            // Si el archivo es más antiguo que el TTL del menú, eliminarlo para forzar descarga nueva
            if (fileAgeMs > MENU_CACHE_TTL) {
                try {
                    fs.unlinkSync(filePath)
                } catch (err) {
                    console.error(`Error al eliminar archivo caché antiguo ${filename}:`, err.message)
                }
            } else {
                downloadSemaphore.release()
                return filePath
            }
        }

        // Verificar si la URL es válida
        if (!url || url === 'null' || url === 'undefined') {
            console.log(`[DOWNLOAD] URL inválida para ${filename}, retornando null`)
            downloadSemaphore.release()
            return null
        }

        const response = await axios.get(url, {
            responseType: 'stream',
            timeout: IMAGE_TIMEOUT_MS
        })

        const writer = fs.createWriteStream(filePath)
        response.data.pipe(writer)

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                writer.close()
                reject(new Error(`Timeout downloading ${filename}`))
            }, IMAGE_TIMEOUT_MS)

            writer.on('finish', () => {
                clearTimeout(timer)
                downloadSemaphore.release()
                resolve(filePath)
            })
            
            writer.on('error', (err) => {
                clearTimeout(timer)
                downloadSemaphore.release()
                reject(err)
            })
        })
    } catch (error) {
        downloadSemaphore.release()
        console.error(`[DOWNLOAD] Error con ${filename}:`, error.message)
        return null
    }
}

// Función para limpiar caché con mejor manejo de errores
const cleanImageCache = () => {
    try {
        const files = fs.readdirSync(IMAGE_CACHE_DIR)
        files.forEach(file => {
            try {
                fs.unlinkSync(path.join(IMAGE_CACHE_DIR, file))
            } catch (err) {
                console.error(`Error al eliminar archivo ${file}:`, err.message)
            }
        })
    } catch (err) {
        console.error('Error al limpiar caché de imágenes:', err.message)
    }
}

// Cache para el menú por 5 minutos para reducir llamadas a la API
let menuCache = null
let menuCacheTime = 0
const MENU_CACHE_TTL = 0.1 * 60 * 1000 // 5 minutos

const menuAPI = async () => {
    try {
        // Usar caché si está disponible y es reciente
        const now = Date.now()
        if (menuCache && (now - menuCacheTime) < MENU_CACHE_TTL) {
            return [...menuCache] // Retornar copia para evitar modificaciones
        }

        const response = await axios.get('http://127.0.0.1:8000/admin/menu/MenuHoy', {
            timeout: 10000 // 10 segundos máximo para la API
        })
        
        const menu = response.data.menu.map((item) => {
            // Verificar que la imagen_url sea válida
            const imagen_url = item.imagen_url && item.imagen_url !== 'null' && item.imagen_url !== 'undefined' 
                ? item.imagen_url 
                : null;
                
            return {
                id: item.id,
                cantidad_patillo: item.cantidad_disponible,
                nombre_platillo: item.nombre,
                precio_platillo: item.precio_base,
                imagen_url: imagen_url,
                imagen_filename: imagen_url ? `${item.id}_${path.basename(imagen_url)}` : null,
                body: `🍽️ ${item.nombre}\n💵 Precio: Lps ${item.precio_base}\n📦 ${item.cantidad_disponible > 0 ? `Disponibles: ${item.cantidad_disponible}` : 'Disponibles: *Platillo agotado*'}\n📝 Descripción: ${item.descripcion}`
            }
        })
        
        // Actualizar caché
        menuCache = [...menu]
        menuCacheTime = now
        
        return menu
    } catch (error) {
        console.error('Error al obtener el menú:', error)
        // En caso de error, retornar un arreglo vacío en lugar del caché antiguo
        // para evitar mostrar información desactualizada
        return []
    }
}

// Flujo de pedido mejorado con mejor manejo de errores y claridad en el código
const flowPedido = addKeyword(['__Flujo De Pedido Completo__'])
    .addAnswer(
        '📝 *Selecciona un platillo:*\n\n' +
        'Escribe solo el *número* del platillo que deseas:\n\n',
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic, gotoFlow, endFlow }) => {
            try {
                reset(ctx, gotoFlow, 60000)
                const menu = await menuAPI()

                if (!menu || menu.length === 0) {
                    stop(ctx)
                    return endFlow('⚠️ El menú de hoy ha sido modificado o eliminado. Por favor, escribe "hola" para comenzar de nuevo.')
                }
                
                await state.update({ menu })
                const choice = parseInt(ctx.body)

                if (isNaN(choice) || choice < 1 || choice > menu.length) {
                    return fallBack('❌ Opción inválida. Por favor, escribe un número válido:')
                }
                
                const pedido = menu[choice - 1]
                
                if (pedido.cantidad_patillo === 0) {
                    return fallBack(`*PLATILLO AGOTADO*
El platillo que seleccionaste (${pedido.nombre_platillo}) ya no está disponible.
🔄 Por favor elige otro platillo de la lista`)
                }

                await state.update({
                    pedidoId: pedido.id,
                    pedidoBody: pedido.body,
                    pedidoCantidadDisponible: pedido.cantidad_patillo,
                    nombre_platillo: pedido.nombre_platillo,
                    precio_platillo: pedido.precio_platillo
                })
            } catch (error) {
                console.error('Error en selección de platillo:', error)
                stop(ctx)
                return endFlow('❌ Ocurrió un error. Intenta de nuevo escribiendo *HOLA*')
            }
        }
    )
    .addAnswer(
        null,
        async (ctx, { state, flowDynamic }) => {
            const { pedidoBody } = state.getMyState()
            await flowDynamic(`✅ Has pedido: ${pedidoBody}`)
        }
    )
    .addAnswer(
        '🔢 ¿Cuántas unidades deseas pedir?',
        { capture: true },
        async (ctx, { state, fallBack, endFlow, gotoFlow }) => {
            try {
                reset(ctx, gotoFlow, 60000)
                const myState = state.getMyState()
                const cantidad = parseInt(ctx.body)

                if (isNaN(cantidad)) {
                    return fallBack('❌ Por favor, ingresa un número válido:')
                }

                if (cantidad <= 0) {
                    return fallBack('❌ La cantidad debe ser mayor a 0. Por favor, ingresa una cantidad válida:')
                }

                if (cantidad > myState.pedidoCantidadDisponible) {
                    return fallBack(`❌ No hay suficiente disponibilidad. Solo quedan ${myState.pedidoCantidadDisponible} unidades. Por favor, ingresa una cantidad menor:`)
                }

                await state.update({ cantidadPedido: cantidad })
            } catch (error) {
                console.error('Error en cantidad de pedido:', error)
                stop(ctx)
                return endFlow('❌ Ocurrió un error. Intenta de nuevo escribiendo *HOLA*')
            }
        }
    )
    .addAnswer(
        '📍 *Por favor, comparte tu ubicación* 📍\n\n' +
        'Usa la función de WhatsApp:\n' +
        '📎 *Adjuntar* → *Ubicación* → *Enviar tu ubicación actual*',
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow }) => {
            try {
                reset(ctx, gotoFlow, 60000)

                if (ctx.type !== 'location' || !ctx.lat || !ctx.lng) {
                    return fallBack('❌ Por favor, usa el menú de *Adjuntar → Ubicación* para compartir tu ubicación real.')
                }

                await state.update({
                    ubicacion: {
                        latitud: ctx.lat,
                        longitud: ctx.lng,
                        timestamp: ctx.timestamp
                    }
                })
            } catch (error) {
                console.error('Error procesando ubicación:', error)
                stop(ctx)
                return fallBack('❌ Error al procesar tu ubicación. Por favor, inténtalo de nuevo.')
            }
        }
    )
    .addAnswer(
        '📋 Procesando tu pedido...',
        null,
        async (ctx, { flowDynamic, state, endFlow }) => {
            try {
                const myState = state.getMyState()

                if (!myState.nombre_platillo || !myState.cantidadPedido || !myState.ubicacion) {
                    stop(ctx)
                    return endFlow('❌ Error: Faltan datos del pedido. Por favor inicia nuevamente.')
                }
                
                const pedidoData = {
                    nombre: ctx.pushName || 'Usuario',
                    telefono: ctx.from,
                    latitud: myState.ubicacion.latitud,
                    longitud: myState.ubicacion.longitud,
                    platillos: [{
                        id: myState.pedidoId,
                        cantidad: myState.cantidadPedido
                    }]
                }

                try {
                    const response = await fetch('http://127.0.0.1:8000/api/bot-pedido', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(pedidoData),
                        timeout: 15000 // 15 segundos máximo para la API
                    })

                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}))
                        throw new Error(
                            errorData.mensaje ||
                            `Error HTTP: ${response.status} - ${response.statusText}`
                        )
                    }

                    const data = await response.json()

                    
                } catch (error) {
                    console.error('Error en la solicitud:', error)

                    let errorMessage = '❌ Ocurrió un error al procesar tu pedido.'

                    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
                        errorMessage = '❌ No se pudo conectar con el servidor. Intenta nuevamente.'
                    } else if (error.message) {
                        errorMessage = `❌ ${error.message} o el menú fue modificado, por favor vuelve a escribir *HOLA* para iniciar de nuevo.`
                    }
                    
                    stop(ctx)
                    return endFlow(errorMessage)
                }
                
                const resumenDefinitivo = `
    ✅ *PEDIDO CONFIRMADO*
    ━━━━━━━━━━━━━━━━━━
    🗒️ *Detalle:*
    • Cliente: ${ctx.pushName || 'Usuario'}
    • Telefono: ${ctx.from || 'Usuario'}
    • Platillo: ${myState.nombre_platillo}
    • Cantidad: ${myState.cantidadPedido}
    • Total: $${(myState.precio_platillo * myState.cantidadPedido).toFixed(2)}
    ━━━━━━━━━━━━━━━━━━
    📦 *Entrega:*
    Coordenadas guardadas:
    - Lat: ${myState.ubicacion.latitud}
    - Lng: ${myState.ubicacion.longitud}
    ━━━━━━━━━━━━━━━━━━
    🚚 *¡Gracias por tu compra!*
    `.trim()

                await flowDynamic(resumenDefinitivo)
                stop(ctx)
            } catch (error) {
                console.error('Error al generar resumen:', error)
                stop(ctx)
                return endFlow('❌ Ocurrió un error al procesar tu pedido. Por favor contacta al soporte o vuelve a intentar escribiendo *hola*.')
            }
        }
    )

const flowNoPedido = addKeyword(['__Pedido__'])
    .addAnswer(
        '*Parece que no deseas hacer un pedido por el momento.*\n\n' +
        '¡No hay problema! Si alguna vez te antojas de algo delicioso, solo escribe *Hola* 🍽️ y te mostraremos nuestras opciones nuevamente. 😋\n\n' +
        'Gracias por tu tiempo y por estar con nosotros. ¡Esperamos verte pronto!\n\n' +
        '*¡Te deseamos un excelente día!* ✨💫'
    )

// Flujo de menú mejorado con mejor manejo de imágenes y concurrencia
const hoy = new Date()
const opcionesFecha = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
const fechaFormateada = hoy.toLocaleDateString('es-ES', opcionesFecha)

const MenuDelDia = addKeyword(['1'])
    .addAnswer(
        `🗓️ Menú del día:\n ${fechaFormateada}\n`,
        null,
        async (ctx, { flowDynamic, gotoFlow, endFlow, state }) => {
            try {
                const data = await menuAPI()
                
                if (data.length === 0) {
                    stop(ctx)
                    return endFlow('😊 No hay menú disponible hoy.')
                }

                // Guardar menú en el estado para uso posterior
                await state.update({ menuData: data })

                // Procesar cada platillo individualmente con manejo de errores
                let contador = 1
                for (const item of data) {
                    try {
                        // Usar formato emoji para el contador
                        const numeroEmoji = contador.toString()
                            .replace(/0/g, '0️⃣')
                            .replace(/1/g, '1️⃣')
                            .replace(/2/g, '2️⃣')
                            .replace(/3/g, '3️⃣')
                            .replace(/4/g, '4️⃣')
                            .replace(/5/g, '5️⃣')
                            .replace(/6/g, '6️⃣')
                            .replace(/7/g, '7️⃣')
                            .replace(/8/g, '8️⃣')
                            .replace(/9/g, '9️⃣')

                        // Descargar imagen para este platillo
                        let imagePath = null
                        let mensaje = `\n──────────────\n${numeroEmoji} *${item.nombre_platillo}*\n──────────────\n${item.body}`
                        
                        // Verificar si el platillo tiene una URL de imagen válida
                        if (item.imagen_url && item.imagen_url !== 'null' && item.imagen_url !== 'undefined') {
                            try {
                                imagePath = await downloadImage(
                                    `http://127.0.0.1:8000/storage/${item.imagen_url}`,
                                    item.imagen_filename
                                )
                                
                                if (!imagePath) {
                                    mensaje += "\n\n⚠️ *Imagen no disponible*"
                                }
                            } catch (imageError) {
                                console.error(`Error al descargar imagen para platillo ${item.nombre_platillo}:`, imageError)
                                mensaje += "\n\n⚠️ *Error al cargar la imagen*"
                            }
                        } else {
                            mensaje += "\n\n⚠️ *Sin imagen*"
                        }

                        // Enviar mensaje con o sin imagen
                        await flowDynamic([{
                            body: mensaje,
                            media: imagePath || null
                        }])

                        contador++

                        // Eliminar imagen para liberar espacio
                        if (imagePath && fs.existsSync(imagePath)) {
                            fs.unlink(imagePath, (err) => {
                                if (err) console.error(`Error al eliminar ${imagePath}:`, err)
                            })
                        }
                    } catch (itemError) {
                        console.error(`Error al procesar platillo #${contador}:`, itemError)
                        // Intenta enviar un mensaje de error para este platillo específico
                        try {
                            await flowDynamic(`❌ Error al mostrar platillo #${contador}. Por favor intenta nuevamente.`)
                        } catch (e) {
                            console.error('Error al enviar mensaje de error:', e)
                        }
                        // Continuar con el siguiente platillo sin romper el flujo
                        contador++
                    }
                }

                // Limpiar todas las imágenes al finalizar
                cleanImageCache()
            } catch (error) {
                stop(ctx)
                console.error('Error general al mostrar menú:', error)
                return endFlow('❌ Ocurrió un error al mostrar el menú. Por favor escribe *HOLA* para intentar nuevamente.')
            }
        }
    )
    .addAnswer(
        '¿Deseas pedir alguno de estos platillos? (responde *sí* o *no*)',
        { capture: true },
        async (ctx, { fallBack, gotoFlow }) => {
            const respuesta = ctx.body
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()

            if (respuesta === 'si' || respuesta === 'no') {
                if (respuesta === 'si') {
                    reset(ctx, gotoFlow, 60000)
                    return gotoFlow(flowPedido)
                } else {
                    stop(ctx)
                    return gotoFlow(flowNoPedido)
                }
            } else {
                return fallBack('❌ Por favor responde únicamente con *sí* o *no*.')
            }
        }
    )

const welcomeFlow = addKeyword(['hola', 'ole', 'alo']) .addAction(async (ctx, { gotoFlow }) => start(ctx, gotoFlow, 60000))
    .addAnswer('🍽️ ¡Bienvenido a La Campaña! 🎉 Hola 👋, soy tu asistente virtual y estoy aquí para ayudarte con tu pedido. Para continuar, elige una opción marcando el número correspondiente', {
        media: join(process.cwd(), 'src', 'lacampaña.jpg')
    })
    .addAnswer(
        [
            '1️⃣ Ver nuestro menú 📋',
            '2️⃣ Hablar con un asesor 📞',
            '3️⃣ Nuestras redes sociales 📢'
        ],
        { capture: true },
        async (ctx, { fallBack }) => {
            if (!['1', '2', '3'].includes(ctx.body.trim())) {
                return fallBack('❌ Opción inválida. Escribe 1, 2 o 3')
            }
        },
        [MenuDelDia],
        { delay: 1000 } // Reducido a 1 segundo para mejor experiencia de usuario
    )

// Los otros flujos se mantienen igual...
const registerFlow = addKeyword(utils.setEvent('REGISTER_FLOW'))
    .addAnswer(`What is your name?`, { capture: true }, async (ctx, { state }) => {
        await state.update({ name: ctx.body })
    })
    .addAnswer('What is your age?', { capture: true }, async (ctx, { state }) => {
        await state.update({ age: ctx.body })
    })
    .addAction(async (_, { flowDynamic, state }) => {
        await flowDynamic(`${state.get('name')}, thanks for your information!: Your age: ${state.get('age')}`)
    })

const fullSamplesFlow = addKeyword(['samples', utils.setEvent('SAMPLES')])
    .addAnswer(`💪 I'll send you a lot files...`)
    .addAnswer(`Send image from Local`, { media: join(process.cwd(), 'assets', 'sample.png') })
    .addAnswer(`Send video from URL`, {
        media: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExYTJ0ZGdjd2syeXAwMjQ4aWdkcW04OWlqcXI3Ynh1ODkwZ25zZWZ1dCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/LCohAb657pSdHv0Q5h/giphy.mp4',
    })
    .addAnswer(`Send audio from URL`, { media: 'https://cdn.freesound.org/previews/728/728142_11861866-lq.mp3' })
    .addAnswer(`Send file from URL`, {
        media: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    })

const main = async () => {
    const adapterFlow = createFlow([welcomeFlow, flowPedido, flowNoPedido, registerFlow, fullSamplesFlow, idleFlow])

    const adapterProvider = createProvider(Provider, {
        puppeteerOptions: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            timeout: 120000 // Aumentar timeout para evitar problemas de conexión
        }
    })
    
    const adapterDB = new Database({
        host: '127.0.0.1',
        user: 'root',
        database: 'bot',
        password: '',
        connectionLimit: 10 // Limitar conexiones a la BD
    })

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    httpServer(+PORT)
}

main()