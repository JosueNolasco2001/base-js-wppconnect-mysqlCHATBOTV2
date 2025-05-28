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
// Añadir un sistema de bloqueo para evitar solicitudes concurrentes al menú
let menuRequestInProgress = false;
let menuRequestLock = Promise.resolve();

// Función mejorada para descargar imágenes con mejor manejo de errores
const downloadImage = async (url, filename) => {
    await downloadSemaphore.acquire();
    const filePath = path.join(IMAGE_CACHE_DIR, filename);
    
    try {
        // Verificar si la URL es válida antes de intentar cualquier operación
        if (!url || typeof url !== 'string' || url === 'null' || url === 'undefined') {
            console.log(`[DOWNLOAD] URL inválida para ${filename}, retornando null`);
            downloadSemaphore.release();
            return null;
        }

        // Verificar si la imagen ya existe en caché
        if (fs.existsSync(filePath)) {
            // Verificar cuándo se creó el archivo
            const stats = fs.statSync(filePath);
            const fileAgeMs = Date.now() - stats.mtimeMs;
            
            // Si el archivo es más antiguo que el TTL del menú, eliminarlo para forzar descarga nueva
            if (fileAgeMs > MENU_CACHE_TTL) {
                try {
                    fs.unlinkSync(filePath);
                } catch (err) {
                    console.error(`Error al eliminar archivo caché antiguo ${filename}:`, err.message);
                }
            } else {
                downloadSemaphore.release();
                return filePath;
            }
        }

        // Convertir la URL en una URL válida
        const validUrl = url.startsWith('http') ? url : `http://127.0.0.1:8000/storage/${url}`;
        
        // Verificar que la URL es válida antes de hacer la petición
        try {
            new URL(validUrl);
        } catch (e) {
            console.error(`[DOWNLOAD] URL inválida: ${validUrl}`);
            downloadSemaphore.release();
            return null;
        }

        const response = await axios.get(validUrl, {
            responseType: 'stream',
            timeout: IMAGE_TIMEOUT_MS,
            validateStatus: status => status >= 200 && status < 300 // Solo aceptar respuestas exitosas
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                writer.close();
                reject(new Error(`Timeout downloading ${filename}`));
            }, IMAGE_TIMEOUT_MS);

            writer.on('finish', () => {
                clearTimeout(timer);
                downloadSemaphore.release();
                resolve(filePath);
            });
            
            writer.on('error', (err) => {
                clearTimeout(timer);
                downloadSemaphore.release();
                reject(err);
            });
        });
    } catch (error) {
        downloadSemaphore.release();
        console.error(`[DOWNLOAD] Error con ${filename}:`, error.message);
        return null;
    }
};

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

// Versión mejorada del menuAPI con sistema de bloqueo
const menuAPI = async () => {
    // Si ya hay una solicitud en progreso, esperar a que termine
    if (menuRequestInProgress) {
        await menuRequestLock;
        
        // Después de esperar, si el caché es reciente, usar el caché
        const now = Date.now();
        if (menuCache && (now - menuCacheTime) < MENU_CACHE_TTL) {
            console.log("[MENU] Usando caché después de esperar solicitud anterior");
            return structuredClone(menuCache); // Usar copia profunda para evitar modificaciones
        }
    }
    
    // Crear nueva promesa para el bloqueo
    let unlockRequest;
    menuRequestLock = new Promise(resolve => {
        unlockRequest = resolve;
    });
    
    menuRequestInProgress = true;
    
    try {
        // Usar caché si está disponible y es reciente
        const now = Date.now();
        if (menuCache && (now - menuCacheTime) < MENU_CACHE_TTL) {
            console.log("[MENU] Usando caché reciente");
            return structuredClone(menuCache); // Usar copia profunda para evitar modificaciones
        }

        console.log("[MENU] Obteniendo nuevo menú de la API");
        const response = await axios.get('http://127.0.0.1:8000/admin/menu/MenuHoy', {
            timeout: 10000 // 10 segundos máximo para la API
        });
        
        if (!response.data || !response.data.menu || !Array.isArray(response.data.menu)) {
            console.error("[MENU] Respuesta de API inválida:", response.data);
            throw new Error("Formato de respuesta inválido");
        }
        
        const menu = response.data.menu.map((item) => {
            // Verificar que la imagen_url sea válida
            let imagen_url = item.imagen_url;
            let imagen_filename = null;
            
            if (imagen_url && imagen_url !== 'null' && imagen_url !== 'undefined') {
                try {
                    // Verificar si es una URL válida
                    new URL(imagen_url.startsWith('http') ? imagen_url : `http://127.0.0.1:8000/storage/${imagen_url}`);
                    imagen_filename = `${item.id}_${path.basename(imagen_url)}`;
                } catch (e) {
                    console.error(`[MENU] URL inválida para platillo ${item.id}:`, imagen_url);
                    imagen_url = null;
                    imagen_filename = null;
                }
            } else {
                imagen_url = null;
            }
            
            return {
                id: item.id,
                cantidad_patillo: item.cantidad_disponible || 0,
                nombre_platillo: item.nombre || 'Platillo sin nombre',
                precio_platillo: item.precio_base || 0,
                imagen_url: imagen_url,
                imagen_filename: imagen_filename,
                body: `🍽️ ${item.nombre || 'Platillo sin nombre'}\n💵 Precio: Lps ${item.precio_base || 0}\n📦 ${item.cantidad_disponible > 0 ? `Disponibles: ${item.cantidad_disponible}` : 'Disponibles: *Platillo agotado*'}\n📝 Descripción: ${item.descripcion || 'Sin descripción'}`
            };
        });
        
        // Actualizar caché con copia profunda para evitar modificaciones accidentales
        menuCache = structuredClone(menu);
        menuCacheTime = now;
        
        return structuredClone(menu); // Retornar copia para evitar modificaciones
    } catch (error) {
        console.error('[MENU] Error al obtener el menú:', error.message);
        return menuCache || []; // Usar caché antiguo en caso de error o arreglo vacío
    } finally {
        // Liberar el bloqueo
        menuRequestInProgress = false;
        unlockRequest();
    }
};

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
    ).addAnswer(
    '🚚 Calculando costo de envío...',
    null,
    async (ctx, { flowDynamic, state, fallBack, gotoFlow }) => {
        try {
            const myState = state.getMyState()
            
            // Llamar a la API de distancia
            const distanceResponse = await fetch('http://127.0.0.1:8000/api/vehicle/distance', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    target_lat: myState.ubicacion.latitud,
                    target_lng: myState.ubicacion.longitud
                }),
                timeout: 10000
            })

            if (!distanceResponse.ok) {
                throw new Error('Error al calcular distancia')
            }

            const distanceData = await distanceResponse.json()
            
            if (!distanceData.success) {
                throw new Error('No se pudo calcular la distancia')
            }

            const routeInfo = distanceData.data.route_info
            const distanciaKm = routeInfo.distance.km
            const tiempoMin = routeInfo.adjusted_delivery_time?.adjusted_time?.minutes || 
                            routeInfo.delivery_estimate?.total_time?.minutes || 0

            // Calcular costo según la lógica del controlador
            const hoy = new Date()
            const diaSemana = hoy.getDay() // 0=domingo, 6=sábado
            
            let costoEnvio = 0
            if (diaSemana === 6 || distanciaKm <= 0.7) {
                costoEnvio = 0
            } else {
                costoEnvio = Math.max(60, 20 + (7.5 * distanciaKm) + (1.7 * tiempoMin))
            }

            const subtotal = myState.precio_platillo * myState.cantidadPedido
            const totalConEnvio = subtotal + costoEnvio

            await state.update({ 
                costoEnvio, 
                distanciaKm, 
                tiempoMin,
                totalConEnvio 
            })

            const mensaje = `📊 *RESUMEN DE TU PEDIDO*
━━━━━━━━━━━━━━━━━━
🍽️ ${myState.nombre_platillo} x${myState.cantidadPedido}
💰 Subtotal: Lps ${subtotal.toFixed(2)}

🚚 *INFORMACIÓN DE ENTREGA:*
📏 Distancia: ${distanciaKm.toFixed(2)} km
⏱️ Tiempo estimado: ${tiempoMin} minutos
💵 Costo de envío: ${costoEnvio === 0 ? 'GRATIS' : `Lps ${costoEnvio.toFixed(2)}`}
${costoEnvio === 0 ? (diaSemana === 6 ? '🎉 ¡Envío gratis los sábados!' : '🎉 ¡Envío gratis por cercanía!') : ''}

💳 *TOTAL A PAGAR: Lps ${totalConEnvio.toFixed(2)}*
━━━━━━━━━━━━━━━━━━`

            await flowDynamic(mensaje)

        } catch (error) {
            console.error('Error calculando envío:', error)
            await flowDynamic('⚠️ No pudimos calcular el costo de envío exacto, pero continuaremos con tu pedido.')
            await state.update({ costoEnvio: 0, totalConEnvio: myState.precio_platillo * myState.cantidadPedido })
        }
    }
)
.addAnswer(
    '¿Confirmas tu pedido? (responde *sí* o *no*)',
    { capture: true },
    async (ctx, { fallBack, gotoFlow, endFlow, state }) => {
        const respuesta = ctx.body
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()

        if (respuesta === 'si') {
            reset(ctx, gotoFlow, 60000)
            return // Continúa al siguiente paso (procesamiento del pedido)
        } else if (respuesta === 'no') {
            stop(ctx)
            return endFlow('❌ Pedido cancelado.\n\n¡No hay problema! Si cambias de opinión, escribe *HOLA* para hacer un nuevo pedido. 😊')
        } else {
            return fallBack('❌ Por favor responde únicamente con *sí* o *no*.')
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
                const nombreUsuario2 = ctx?.notification?.name || ctx?.sender?.pushname || ctx?.pushName || 'Usuario';

                const pedidoData = {
                    nombre: nombreUsuario2 || 'Usuario',
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
                    console.log(data,"locoooo mira esto JAJSDJAJSDJASD")

                    
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
                const nombreUsuario = ctx?.notification?.name || ctx?.sender?.pushname || ctx?.pushName || 'Usuario';

  const resumenDefinitivo = `
✅ *PEDIDO CONFIRMADO*
━━━━━━━━━━━━━━━━━━
🗒️ *Detalle:*
- Cliente: ${nombreUsuario || 'Usuario'}
- Platillo: ${myState.nombre_platillo}
- Cantidad: ${myState.cantidadPedido}
- Subtotal: Lps ${(myState.precio_platillo * myState.cantidadPedido).toFixed(2)}
- Envío: ${myState.costoEnvio === 0 ? 'GRATIS' : `Lps ${myState.costoEnvio.toFixed(2)}`}
- *TOTAL: Lps ${myState.totalConEnvio.toFixed(2)}*
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
    .addAction(async (ctx) => {
        // Agregar un identificador único para cada solicitud de menú
        ctx.menuRequestId = Date.now() + Math.random().toString(36).substring(2, 10);
        console.log(`[MENU] Nueva solicitud de menú ID: ${ctx.menuRequestId}`);
    })
    .addAnswer(
        `🗓️ Menú del día:\n ${fechaFormateada}\n`,
        null,
        async (ctx, { flowDynamic, gotoFlow, endFlow, state }) => {
            const requestId = ctx.menuRequestId;
            console.log(`[MENU] Procesando solicitud ${requestId}`);
            
            try {
                // Obtener el menú con el sistema de bloqueo ya incorporado
                const data = await menuAPI();
                
                if (!data || data.length === 0) {
                    stop(ctx);
                    return endFlow('😊 No hay menú disponible hoy.');
                }

                // Guardar menú en el estado para uso posterior
                await state.update({ menuData: data });
                
                // Variable para rastrear si este proceso sigue siendo válido
                let isProcessingCancelled = false;
                
                // Comprobar periódicamente si hay una solicitud más reciente
                const checkIntervalId = setInterval(() => {
                    if (ctx.menuRequestId !== requestId) {
                        console.log(`[MENU] Solicitud ${requestId} cancelada por una más reciente`);
                        isProcessingCancelled = true;
                        clearInterval(checkIntervalId);
                    }
                }, 500);

                // Procesar cada platillo individualmente con manejo de errores
                let contador = 1;
                for (const item of data) {
                    // Si se ha cancelado, detener el procesamiento
                    if (isProcessingCancelled) break;
                    
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
                            .replace(/9/g, '9️⃣');

                        // Configurar mensaje base
                        let mensaje = `\n──────────────\n${numeroEmoji} *${item.nombre_platillo}*\n──────────────\n${item.body}`;
                        let imagePath = null;
                        
                        // Verificar si el platillo tiene una URL de imagen válida
                        if (item.imagen_url && item.imagen_filename) {
                            try {
                                // Comprobar nuevamente si el proceso ha sido cancelado antes de descargar
                                if (isProcessingCancelled) break;
                                
                                imagePath = await downloadImage(
                                    item.imagen_url,
                                    item.imagen_filename
                                );
                                
                                if (!imagePath) {
                                    mensaje += "\n\n⚠️ *Imagen no disponible*";
                                }
                            } catch (imageError) {
                                console.error(`[MENU] Error al descargar imagen para platillo ${item.nombre_platillo}:`, imageError);
                                mensaje += "\n\n⚠️ *Error al cargar la imagen*";
                                imagePath = null;
                            }
                        } else {
                            mensaje += "\n\n⚠️ *Sin imagen*";
                        }

                        // Comprobar nuevamente si el proceso ha sido cancelado antes de enviar
                        if (isProcessingCancelled) break;
                        
                        // Enviar mensaje con o sin imagen
                        if (imagePath) {
                            await flowDynamic([{
                                body: mensaje,
                                media: imagePath
                            }]);
                        } else {
                            // Si no hay imagen, enviar solo texto para evitar errores
                            await flowDynamic(mensaje);
                        }

                        contador++;

                        // Eliminar imagen para liberar espacio
                        if (imagePath && fs.existsSync(imagePath)) {
                            fs.unlink(imagePath, (err) => {
                                if (err) console.error(`[MENU] Error al eliminar ${imagePath}:`, err);
                            });
                        }
                    } catch (itemError) {
                        console.error(`[MENU] Error al procesar platillo #${contador} en solicitud ${requestId}:`, itemError);
                        
                        // Comprobar si el proceso ha sido cancelado antes de enviar mensaje de error
                        if (!isProcessingCancelled) {
                            try {
                                await flowDynamic(`❌ Hubo un problema al mostrar el platillo #${contador}. Continuamos con los demás...`);
                            } catch (e) {
                                console.error('[MENU] Error al enviar mensaje de error:', e);
                            }
                        }
                        
                        // Continuar con el siguiente platillo sin romper el flujo
                        contador++;
                    }
                }
                
                // Limpiar intervalo y cache
                clearInterval(checkIntervalId);
                cleanImageCache();
                
                // Si se canceló el procesamiento, no continuar con la siguiente pregunta
                if (isProcessingCancelled) {
                    return endFlow();
                }
            } catch (error) {
                console.error(`[MENU] Error general al mostrar menú en solicitud ${requestId}:`, error);
                stop(ctx);
                return endFlow('❌ Ocurrió un error al mostrar el menú. Por favor escribe *HOLA* para intentar nuevamente.');
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
const flowAsesor = addKeyword(['2'])
    .addAnswer(
        '📞 *Contactar con un asesor*\n\n' +
        'Nuestros asesores están disponibles para ayudarte de:\n' +
        '🕘 Lunes a Viernes: 9:00 AM - 6:00 PM\n' +
        '🕘 Sábados: 10:00 AM - 2:00 PM\n\n' +
        'Puedes comunicarte con nosotros a través de:\n' +
        '📱 Teléfono: +504 1234-5678\n' +
        '✉️ Email: atencion@lacampana.hn\n\n' +
        'Estaremos encantados de atenderte personalmente.'
    )
    .addAnswer(
        'Si necesitas ayuda inmediata, escribe *HOLA* para volver al menú principal.',
        { delay: 2000 },
        async (ctx) => {
            stop(ctx)
        }
    )

const flowRedes = addKeyword(['3'])
    .addAnswer(
        '📢 *Nuestras redes sociales*\n\n' +
        '¡Síguenos para conocer nuestras promociones, novedades y más!\n\n' +
        '📸 Instagram: @LaCampanaHN\n' +
        '👍 Facebook: /LaCampanaHN\n' +
        '🐦 Twitter: @LaCampanaHN\n' +
        '📌 TikTok: @LaCampanaHN\n\n' +
        'Visita nuestro sitio web: www.lacampana.hn'
    )
    .addAnswer(
        '¡Gracias por seguirnos! Escribe *HOLA* cuando quieras volver al menú principal.',
        { delay: 2000 },
        async (ctx) => {
            stop(ctx)
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
        [MenuDelDia,flowRedes,flowAsesor],
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