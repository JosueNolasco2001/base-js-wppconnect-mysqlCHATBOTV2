import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, utils,EVENTS } from '@builderbot/bot'
import { MysqlAdapter as Database } from '@builderbot/database-mysql'
import { WPPConnectProvider as Provider } from '@builderbot/provider-wppconnect'
import axios from 'axios';  // <-- Añade esto al inicio
import { idleFlow, start, reset, stop } from './idle-custom.js';


const PORT = process.env.PORT ?? 3008


const flowPedido = addKeyword(['__Flujo De Pedido Completo__'])
    .addAnswer(    '📝 *Selecciona un platillo:*\n\n' +
        'Escribe solo el *número* del platillo que deseas:\n\n',
        { 
        capture: true 
    }, async (ctx, { state, fallBack,flowDynamic,endFlow }) => { // <- Añade fallBack aquí
        try {
           
            const menu = await menuAPI();

            // Si el menú viene vacío o no existe
if (!menu || menu.length === 0) {
    
    return endFlow('⚠️ El menú de hoy ha sido modificado o eliminado. Por favor, escribe "hola" para comenzar de nuevo.');
} 
            await state.update({ menu });
            const choice = parseInt(ctx.body);

            if (isNaN(choice) || choice < 1 || choice > menu.length) {
                return fallBack('❌ Opción inválida. Por favor, escribe un número válido:'); // Repite el capture sin reiniciar el flujo
               
            }
            const pedido = menu[choice - 1];
           // Luego verificar disponibilidad
           if (pedido.cantidad_patillo === 0) {
        
            return fallBack(`*PLATILLO AGOTADO*
El platillo  que seleccionaste(${pedido.nombre_platillo}) ya no está disponible.
🔄 Por favor elige otro platillo de la lista`); }
    
            
            await state.update({ 
                pedidoId: pedido.id,   // Guarda el id del platillo
                pedidoBody: pedido.body , // Guarda el cuerpo con toda la información
                pedidoCantidadDisponible: pedido.cantidad_patillo,
                nombre_platillo:pedido.nombre_platillo,
                precio_platillo:pedido.precio_platillo
             
            });

   
       

            
        } catch (error) {
            console.error('Error:', error);
            
            return  endFlow('❌ Ocurrió un error. Intenta de nuevo escribiendo *HOLA*:'); 
        }
    }).addAnswer('sos nasty',null,  async (ctx, { state,flowDynamic }) => {
        const myState = state.getMyState();

        await flowDynamic(`✅ Has pedido: ${myState.nombre_platillo}`);
    }).addAnswer('🔢 ¿Cuántas unidades deseas pedir?', { 
        capture: true 
    }, async (ctx, { state, fallBack,endFlow, gotoFlow }) => {
        try {
          
            const myState = state.getMyState();
            const cantidad = parseInt(ctx.body);
            
            if (isNaN(cantidad)) {
                return fallBack('❌ Por favor, ingresa un número válido:');
            }
            
            if (cantidad <= 0) {
                return fallBack('❌ La cantidad debe ser mayor a 0. Por favor, ingresa una cantidad válida:');
            }
            
            if (cantidad > myState.pedidoCantidadDisponible) {
                return fallBack(`❌ No hay suficiente disponibilidad. Solo quedan ${myState.pedidoCantidadDisponible} unidades. Por favor, ingresa una cantidad menor:`);
            }
            
            // Guardamos la cantidad seleccionada
            await state.update({ cantidadPedido: cantidad });
          
            
            
            
        } catch (error) {
            
            return  endFlow('❌ Ocurrió un error. Intenta de nuevo escribiendo *HOLA*:'); 
        }
    }).addAnswer(
        '📍 *Por favor, comparte tu ubicación* 📍\n\n' +
        'Usa la función de WhatsApp:\n' +
        '📎 *Adjuntar* → *Ubicación* → *Enviar tu ubicación actual*',
        { 
            capture: true 
        }, 
        async (ctx, { state, fallBack }) => {
            try {
                console.log('Mensaje recibido:', ctx); // Para depuración
                
                // Verificar si es una ubicación válida (nueva estructura)
                if (ctx.type !== 'location' || !ctx.lat || !ctx.lng) {
                    return fallBack('❌ Por favor, usa el menú de *Adjuntar → Ubicación* para compartir tu ubicación real.');
                }
                
                // Guardar la ubicación
                await state.update({ 
                    ubicacion: { 
                        latitud: ctx.lat, 
                        longitud: ctx.lng,
                        timestamp: ctx.timestamp
                    } 
                });
                
                // Opcional: Confirmar recepción
                return '📍 ¡Ubicación recibida correctamente!';
                
            } catch (error) {
                console.error('Error procesando ubicación:', error);
                return fallBack('❌ Error al procesar tu ubicación. Por favor, inténtalo de nuevo.');
            }
        }
    ) .addAnswer('📋 Procesando tu pedido...', null, async (ctx, { flowDynamic, state, endFlow }) => {
        try {
            const myState = state.getMyState();
            
            // Validamos que todos los datos existan
            if (!myState.nombre_platillo || !myState.cantidadPedido || !myState.ubicacion) {
                return endFlow('❌ Error: Faltan datos del pedido. Por favor inicia nuevamente.');
            }
     // Preparar los datos para enviar al backend
     const pedidoData = {
        nombre: ctx.pushName || 'Usuario',
        telefono: ctx.from,
        latitud: myState.ubicacion.latitud,
        longitud: myState.ubicacion.longitud,
        platillos: [{
            id: myState.pedidoId,
            cantidad: myState.cantidadPedido
        }]
    };

    // Enviar el pedido al backend
try {
    const response = await fetch('http://127.0.0.1:8000/api/bot-pedido', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(pedidoData)
    });

    if (!response.ok) {
        // Si el servidor responde con un código de error (4xx, 5xx)
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.mensaje || 
            `Error HTTP: ${response.status} - ${response.statusText}`
        );
    }

    const data = await response.json();

    if (!data.success) {
        // Si el servidor responde con success: false
        throw new Error(data.mensaje || 'El pedido no pudo ser procesado');
    }

} catch (error) {
    console.error('Error en la solicitud:', error);
    
    let errorMessage = '❌ Ocurrió un error al procesar tu pedido.';
    
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        errorMessage = '❌ No se pudo conectar con el servidor. Intenta nuevamente.';
    } else if (error.message) {
        errorMessage = `❌ ${error.message} o el menu fue modificado,por favor vuelve escribir *HOLA* para iniciar de nuevo.`;
    }
    
    return endFlow(errorMessage);
}
            const resumenDefinitivo = `
    ✅ *PEDIDO CONFIRMADO*
    ━━━━━━━━━━━━━━━━━━
    🗒️ *Detalle:*
    • Cliente: ${ctx.pushName || 'Usuario'}
    • Telefono: ${ctx.from  || 'Usuario'}
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
    `.trim();
    
            await flowDynamic(resumenDefinitivo);
             
           
    
        } catch (error) {
            console.error('Error al generar resumen:', error);
            return endFlow('❌ Ocurrió un error al procesar tu pedido. Por favor contacta al soporte.');
        }
    })
// const welcomeFlow = addKeyword(['hi', 'hello', 'hola'])
//     .addAnswer(`🙌 Hello welcome to this *Chatbot*`)
//     .addAnswer(
//         [
//             'I share with you the following links of interest about the project',
//             '👉 *doc* to view the documentation',
//         ].join('\n'),
//         { delay: 800, capture: true },
//         async (ctx, { fallBack }) => {
//             if (!ctx.body.toLocaleLowerCase().includes('doc')) {
//                 return fallBack('You should type *doc*')
//             }
//             return
//         },
//         [discordFlow]
//     )

const menuAPI = async () => {
    try {
        const response = await axios.get('http://127.0.0.1:8000/admin/menu/MenuHoy');
        return response.data.menu.map((item) => ({
            id: item.id,
            cantidad_patillo:item.cantidad_disponible,
            nombre_platillo:item.nombre,
            precio_platillo:item.precio_base,

            // imagen_completa: `https://127.0.0.1:8000/storage/${item.imagen_url}`,
            body: `🍽️ ${item.nombre}\n💵 Precio: Lps ${item.precio_base}\n📦 ${item.cantidad_disponible > 0 ? `Disponibles: ${item.cantidad_disponible}` : 'Disponibles: *Platillo agotado*'}\n📝 Descripción: ${item.descripcion}`        }));
    } catch (error) {
        console.error('Error al obtener el menú:', error);
        return [];
    }
};
//------------------------------------- Aca nos encargamos de ver el menu del dia de hoy y luego redirige si quiere un platillo-------------------------------------//
const hoy = new Date();
    const opcionesFecha = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const fechaFormateada = hoy.toLocaleDateString('es-ES', opcionesFecha);
const MenuDelDia = addKeyword(['1']) .addAction(async (ctx, { gotoFlow }) => start(ctx, gotoFlow, 10000))

.addAnswer(
    `🗓️Menú del día:\n ${fechaFormateada}\n`,
    null,
    async (ctx, { flowDynamic, gotoFlow,endFlow,state }) => {
  
        const data = await menuAPI();
// Verificar si el menú está vacío
if (data.length === 0) {

return endFlow('😊 Disculpa, hoy no tenemos un menú programado.\n\nPor favor, vuelve a consultar más tarde o comunícate con nosotros para más información.');



}
      
let contador = 1;



for (let item of data) {
// Función para convertir el número a emojis (1 → 1️⃣, 11 → 1️⃣1️⃣)
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

await flowDynamic([
    {
        body: `\n──────────────\n${numeroEmoji} *${item.nombre_platillo}*\n──────────────\n${item.body}`
        // media: item.imagen_completa
    }
]);
contador++;
}
    },
)
.addAnswer(
    '¿Deseas pedir alguno de estos platillos? (responde *sí* o *no*)',
    { capture: true },
    
    async (ctx, { fallBack, gotoFlow }) => {
        const respuesta = ctx.body
            .normalize('NFD') // Normaliza caracteres latinos
            .replace(/[\u0300-\u036f]/g, '') // Elimina tildes
            .toLowerCase(); // Convierte a minúsculas

        if (respuesta === 'si' || respuesta === 'no') {
            if (respuesta === 'si') {
          

                return gotoFlow(flowPedido);
            } else {
            

                return gotoFlow(flowNoPedido);                }
        } else {
            return fallBack('❌ Por favor responde únicamente con *sí* o *no*.');
        }
    }
);

    const welcomeFlow = addKeyword(['hola', 'ole', 'alo'])
    .addAnswer('🍽️ ¡Bienvenido a La Campaña! 🎉 Hola 👋, soy tu asistente virtual y estoy aquí para ayudarte con tu pedido. Para continuar, elige una opción marcando el número correspondiente', {
        media: join(process.cwd(), 'src', 'lacampaña.jpg')
    })
    .addAnswer(
        [
            '1️⃣ Ver nuestro menú 📋',
            '2️⃣ Hacer un pedido 🍔🍕',
            '3️⃣ Consultar el estado de tu pedido ⏳',
            '4️⃣ Conocer nuestras promociones 🔥',
            '5️⃣ Hablar con un asesor 📞',
        ], 
        null,
       null,
         [ MenuDelDia],
        { delay: 2000 }
    );



   




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
    const adapterFlow = createFlow([welcomeFlow, flowPedido,registerFlow, fullSamplesFlow,idleFlow])
    
    const adapterProvider = createProvider(Provider)
    const adapterDB = new Database({
        host:'127.0.0.1',
        user: 'root',
        database: 'bot',
        password: '',
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
