// Mejora en el manejo del menú del día y solución para usuarios concurrentes + MÚLTIPLES PEDIDOS
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




// 1. FUNCIÓN PARA LIMPIAR ESTADO COMPLETO
const limpiarEstadoCompleto = async (state) => {
    await state.clear() // Limpia todo el estado
    // O si prefieres ser más específico:
    /*
    await state.update({
        pedidos: [],
        menuData: null,
        pedidoActualId: null,
        pedidoActualBody: null,
        pedidoActualCantidadDisponible: null,
        pedidoActualNombre: null,
        pedidoActualPrecio: null,
        cantidadActual: null,
        ubicacion: null,
        costoEnvio: 0,
        distanciaKm: 0,
        tiempoMin: 0,
        subtotal: 0,
        totalConEnvio: 0
    })
    */
}
// 2. FUNCIÓN MEJORADA PARA VERIFICAR CANCELACIÓN CON LIMPIEZA DE ESTADO

const verificarCancelacion = async (ctx ,state) => {
    const mensaje = ctx.body
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()

    if (['cancelar', 'cancel', 'salir', 'terminar'].includes(mensaje)) {
        // LIMPIAR TODO EL ESTADO ANTES DE TERMINAR
        await limpiarEstadoCompleto(state)
 return true
    }
    return false
}


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

// NUEVA FUNCIÓN: Mostrar resumen del carrito
const mostrarResumenCarrito = (pedidos) => {
    if (!pedidos || pedidos.length === 0) {
        return "🛒 *Tu carrito está vacío*"
    }

    let resumen = "🛒 *RESUMEN DE TU CARRITO:*\n━━━━━━━━━━━━━━━━━━\n"
    let subtotal = 0

    pedidos.forEach((pedido, index) => {
        const totalPlatillo = pedido.precio_platillo * pedido.cantidad
        subtotal += totalPlatillo
        resumen += `${index + 1}. ${pedido.nombre_platillo}\n`
        resumen += `   Cantidad: ${pedido.cantidad} x Lps ${pedido.precio_platillo} = Lps ${totalPlatillo.toFixed(2)}\n\n`
    })

    resumen += `━━━━━━━━━━━━━━━━━━\n💰 *Subtotal: Lps ${subtotal.toFixed(2)}*\n`
    resumen += `🚚 (El costo de envío se calculará al finalizar)`

    return resumen
}

// Flujo de pedido mejorado con soporte para múltiples pedidos
const flowPedido = addKeyword(['__Flujo De Pedido Completo__'])
    .addAnswer(
        '📝 *Selecciona un platillo:*\n\n' +
        'Escribe solo el *número* del platillo que deseas:\n\n',
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic, gotoFlow, endFlow }) => {
              if (await verificarCancelacion(ctx,state)) {
            stop(ctx)
            return endFlow('❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋')
        }
           

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
                    pedidoActualId: pedido.id,
                    pedidoActualBody: pedido.body,
                    pedidoActualCantidadDisponible: pedido.cantidad_patillo,
                    pedidoActualNombre: pedido.nombre_platillo,
                    pedidoActualPrecio: pedido.precio_platillo
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
            const { pedidoActualBody } = state.getMyState()
            await flowDynamic(`✅ Has seleccionado: ${pedidoActualBody}`)
        }
    )
    .addAnswer(
        '🔢 ¿Cuántas unidades deseas pedir?',
        { capture: true },
        async (ctx, { state, fallBack, endFlow, gotoFlow }) => {
            try {
                 if (await verificarCancelacion(ctx,state)) {
            stop(ctx)
            return endFlow('❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋')
        }
           

                reset(ctx, gotoFlow, 60000)
                const myState = state.getMyState()
                const cantidad = parseInt(ctx.body)

                if (isNaN(cantidad)) {
                    return fallBack('❌ Por favor, ingresa un número válido:')
                }

                if (cantidad <= 0) {
                    return fallBack('❌ La cantidad debe ser mayor a 0. Por favor, ingresa una cantidad válida:')
                }

                if (cantidad > myState.pedidoActualCantidadDisponible) {
                    return fallBack(`❌ No hay suficiente disponibilidad. Solo quedan ${myState.pedidoActualCantidadDisponible} unidades. Por favor, ingresa una cantidad menor:`)
                }

                await state.update({ cantidadActual: cantidad })
            } catch (error) {
                console.error('Error en cantidad de pedido:', error)
                stop(ctx)
                return endFlow('❌ Ocurrió un error. Intenta de nuevo escribiendo *HOLA*')
            }
        }
    )
    .addAnswer(
        '✅ *Platillo agregado al carrito*',
        null,
        async (ctx, { state, flowDynamic }) => {
            const myState = state.getMyState()
            
            // Inicializar array de pedidos si no existe
            let pedidos = myState.pedidos || []
            
            // Agregar el pedido actual al array
            const nuevoPedido = {
                id: myState.pedidoActualId,
                nombre_platillo: myState.pedidoActualNombre,
                precio_platillo: myState.pedidoActualPrecio,
                cantidad: myState.cantidadActual
            }
            
            pedidos.push(nuevoPedido)
            
            // Actualizar estado con el array de pedidos
            await state.update({ pedidos })
            
            // Mostrar resumen del carrito
            const resumenCarrito = mostrarResumenCarrito(pedidos)
            await flowDynamic(resumenCarrito)
        }
    )
    .addAnswer(
        '🛒 ¿Deseas agregar otro platillo a tu pedido?\n\n' +
        'Responde:\n' +
        '• *sí* - Para agregar otro platillo\n' +
        '• *no* - Para continuar con el pedido',
        { capture: true },
        async (ctx, { fallBack, gotoFlow, endFlow, state }) => {
             if (await verificarCancelacion(ctx,state)) {
            stop(ctx)
            return endFlow('❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋')
        }
           

            const respuesta = ctx.body
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()

            if (respuesta === 'si') {
                reset(ctx, gotoFlow, 60000)
                // Volver al inicio del flujo de pedido para seleccionar otro platillo
                return gotoFlow(flowPedido)
            } else if (respuesta === 'no') {
                reset(ctx, gotoFlow, 60000)
                // Continuar con el proceso de ubicación y finalización
                return // Continúa al siguiente paso
            } else {
                return fallBack('❌ Por favor responde únicamente con *sí* o *no*.')
            }
        }
    )
    .addAnswer(
        '📍 *Por favor, comparte tu ubicación* 📍\n\n' +
        'Usa la función de WhatsApp:\n' +
        '📎 *Adjuntar* → *Ubicación* → *Enviar tu ubicación actual*',
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, endFlow }) => {
           if (await verificarCancelacion(ctx,state)) {
            stop(ctx)
            return endFlow('❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋')
        }
           

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

                // Calcular subtotal de todos los pedidos
                const pedidos = myState.pedidos || []
                const subtotal = pedidos.reduce((total, pedido) => {
                    return total + (pedido.precio_platillo * pedido.cantidad)
                }, 0)
                
                const totalConEnvio = subtotal + costoEnvio

                await state.update({ 
                    costoEnvio, 
                    distanciaKm, 
                    tiempoMin,
                    subtotal,
                    totalConEnvio 
                })

                // Generar resumen detallado
                let resumenDetallado = `📊 *RESUMEN COMPLETO DE TU PEDIDO*\n━━━━━━━━━━━━━━━━━━\n`
                
                pedidos.forEach((pedido, index) => {
                    const totalPlatillo = pedido.precio_platillo * pedido.cantidad
                    resumenDetallado += `${index + 1}. ${pedido.nombre_platillo}\n`
                    resumenDetallado += `   ${pedido.cantidad} x Lps ${pedido.precio_platillo} = Lps ${totalPlatillo.toFixed(2)}\n\n`
                })

                resumenDetallado += `💰 Subtotal: Lps ${subtotal.toFixed(2)}\n\n`
                resumenDetallado += `🚚 *INFORMACIÓN DE ENTREGA:*\n`
                resumenDetallado += `📏 Distancia: ${distanciaKm.toFixed(2)} km\n`
                resumenDetallado += `⏱️ Tiempo estimado: ${tiempoMin} minutos\n`
                resumenDetallado += `💵 Costo de envío: ${costoEnvio === 0 ? 'GRATIS' : `Lps ${costoEnvio.toFixed(2)}`}\n`
                
                if (costoEnvio === 0) {
                    resumenDetallado += diaSemana === 6 ? '🎉 ¡Envío gratis los sábados!\n' : '🎉 ¡Envío gratis por cercanía!\n'
                }
                
                resumenDetallado += `\n💳 *TOTAL A PAGAR: Lps ${totalConEnvio.toFixed(2)}*\n━━━━━━━━━━━━━━━━━━`

                await flowDynamic(resumenDetallado)

            } catch (error) {
                console.error('Error calculando envío:', error)
                const myState = state.getMyState()
                const pedidos = myState.pedidos || []
                const subtotal = pedidos.reduce((total, pedido) => {
                    return total + (pedido.precio_platillo * pedido.cantidad)
                }, 0)
                
                await flowDynamic('⚠️ No pudimos calcular el costo de envío exacto, pero continuaremos con tu pedido.')
                await state.update({ costoEnvio: 0, subtotal, totalConEnvio: subtotal })
            }
        }
    )
    .addAnswer(
        '¿Confirmas tu pedido completo? (responde *sí* o *no*)',
        { capture: true },
        async (ctx, { fallBack, gotoFlow, endFlow, state }) => {
  if (await verificarCancelacion(ctx,state)) {
            stop(ctx)
            return endFlow('❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋')
        }
           
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
        '📋 Procesando tu pedido completo...',
        null,
        async (ctx, { flowDynamic, state, endFlow }) => {
            try {
                const myState = state.getMyState()

                if (!myState.pedidos || myState.pedidos.length === 0 || !myState.ubicacion) {
                    stop(ctx)
                    return endFlow('❌ Error: Faltan datos del pedido. Por favor inicia nuevamente.')
                }

                const nombreUsuario2 = ctx?.notification?.name || ctx?.sender?.pushname || ctx?.pushName || 'Usuario';

                // Preparar los datos del pedido con TODOS los platillos
                const pedidoData = {
                    nombre: nombreUsuario2 || 'Usuario',
                    telefono: ctx.from,
                    latitud: myState.ubicacion.latitud,
                    longitud: myState.ubicacion.longitud,
                    platillos: myState.pedidos.map(pedido => ({
                        id: pedido.id,
                        cantidad: pedido.cantidad
                    }))
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
                    console.log(data, "Respuesta del servidor para múltiples pedidos")

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

                // Generar resumen definitivo con todos los platillos
                let resumenDefinitivo = `✅ *PEDIDO CONFIRMADO*\n━━━━━━━━━━━━━━━━━━\n`
                resumenDefinitivo += `🗒️ *Cliente:* ${nombreUsuario || 'Usuario'}\n\n`
                resumenDefinitivo += `📋 *Platillos pedidos:*\n`
                
                myState.pedidos.forEach((pedido, index) => {
                    const totalPlatillo = pedido.precio_platillo * pedido.cantidad
                    resumenDefinitivo += `${index + 1}. ${pedido.nombre_platillo}\n`
                    resumenDefinitivo += `   Cantidad: ${pedido.cantidad} x Lps ${pedido.precio_platillo} = Lps ${totalPlatillo.toFixed(2)}\n`
                })

                resumenDefinitivo += `\n💰 Subtotal: Lps ${myState.subtotal.toFixed(2)}\n`
                resumenDefinitivo += `🚚 Envío: ${myState.costoEnvio === 0 ? 'GRATIS' : `Lps ${myState.costoEnvio.toFixed(2)}`}\n`
                resumenDefinitivo += `💳 *TOTAL: Lps ${myState.totalConEnvio.toFixed(2)}*\n`
                resumenDefinitivo += `━━━━━━━━━━━━━━━━━━\n🚚 *¡Gracias por tu compra!*`

                await flowDynamic(resumenDefinitivo)

                   await limpiarEstadoCompleto(state)
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
        '*¡Te deseamos un excelente día!* ✨💫',
        null,
        async (ctx, { state }) => {
            // LIMPIAR ESTADO AL NO HACER PEDIDO
            await limpiarEstadoCompleto(state)
            stop(ctx)
        }
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
        async (ctx, { fallBack, gotoFlow, endFlow,state }) => {
    if (await verificarCancelacion(ctx,state)) {
            stop(ctx)
            return endFlow('❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋')
        }
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
        async (ctx, { state }) => {
            // LIMPIAR ESTADO AL TERMINAR
            await limpiarEstadoCompleto(state)
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
        async (ctx, { state }) => {
            // LIMPIAR ESTADO AL TERMINAR
            await limpiarEstadoCompleto(state)
            stop(ctx)
        }
    )

const welcomeFlow = addKeyword(['hola', 'ole', 'alo'])
    .addAction(async (ctx, { gotoFlow, state }) => {
        // LIMPIAR ESTADO AL INICIAR NUEVA CONVERSACIÓN
        await limpiarEstadoCompleto(state)
        start(ctx, gotoFlow, 60000)
    })
    .addAnswer('🍽️ ¡Bienvenido a La Campaña! 🎉 Hola 👋, soy tu asistente virtual y estoy aquí para ayudarte con tu pedido. Para continuar, elige una opción marcando el número correspondiente', {
        media: join(process.cwd(), 'src', 'lacampaña.jpg')
    })
    .addAnswer(
        [
            '1️⃣ Ver nuestro menú 📋',
            '2️⃣ Hablar con un asesor 📞',
            '3️⃣ Nuestras redes sociales 📢',
            '💡 *Tip:* En cualquier momento puedes escribir *"cancelar"* para terminar la operación.',
        ],
        { capture: true },
        async (ctx, { fallBack, endFlow, state }) => {
            if (await verificarCancelacion(ctx,state)) {
            stop(ctx)
            return endFlow('❌ *Operación cancelada*\n\nSi deseas hacer un pedido nuevamente, escribe *HOLA* 👋')
        }
           

            if (!['1', '2', '3'].includes(ctx.body.trim())) {
                return fallBack('❌ Opción inválida. Escribe 1, 2 o 3')
            }
        },
        [MenuDelDia, flowRedes, flowAsesor],
        { delay: 1000 }
    )

const main = async () => {
    const adapterFlow = createFlow([welcomeFlow, flowPedido, flowNoPedido, idleFlow])

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