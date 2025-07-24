const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const qrcodeTerminal = require("qrcode-terminal");
const qrcode = require("qrcode");
const express = require("express");
const { MercadoPagoConfig, Payment } = require("mercadopago");


const DIRETORIO_DADOS = "./dados";
const DIRETORIO_MEDIA = "./media";
const DIRETORIO_PRODUTOS = "./produtos";
const ARQUIVO_USUARIOS = `${DIRETORIO_DADOS}/usuarios.json`;
const ARQUIVO_ADMINS = `${DIRETORIO_DADOS}/admins.json`;
const ARQUIVO_DADOS_LOJA = `${DIRETORIO_DADOS}/dadosLoja.json`;
const ARQUIVO_TICKETS = `${DIRETORIO_DADOS}/tickets.json`;
const ARQUIVO_CARRINHOS = `${DIRETORIO_DADOS}/carrinhos.json`;
const ARQUIVO_VENDEDORES = `${DIRETORIO_DADOS}/vendedores.json`;
const ARQUIVO_PEDIDOS = `${DIRETORIO_DADOS}/pedidos.json`;
const ARQUIVO_PEDIDOS_ESPERA = `${DIRETORIO_DADOS}/pedidos_espera.json`;
const CAMINHO_IMAGEM_MENU = `${DIRETORIO_MEDIA}/menu.jpeg`;
const OWNER_JID = "557999076521@s.whatsapp.net";

// --- Configuração do Mercado Pago ---
const MERCADO_PAGO_ACCESS_TOKEN = "APP_USR-2527115960872621-071200-e14620c636fabb090832b680f4425eca-825201574";
const client = new MercadoPagoConfig({ accessToken: MERCADO_PAGO_ACCESS_TOKEN });
const payment = new Payment(client);

// --- Configuração de Descontos ---
const DISCOUNT_TIERS = [
    { threshold: 100, discount: 0.07, message: "seu primeiro presente: 7% de desconto!" },
    { threshold: 200, discount: 0.10, message: "aumentar seu desconto para 10%!" },
    { threshold: 300, discount: 0.15, message: "o desconto máximo de 15%!" },
];

const userState = {};
// Cria os diretórios necessários se não existirem
[
    DIRETORIO_DADOS,
    DIRETORIO_MEDIA,
    DIRETORIO_PRODUTOS,
    `${DIRETORIO_PRODUTOS}/ofertas`,
    `${DIRETORIO_PRODUTOS}/esferas`,
    `${DIRETORIO_PRODUTOS}/contas`,
].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function loadJsonFile(filePath, defaultData = {}) {
    try {
        if (fs.existsSync(filePath))
            return JSON.parse(fs.readFileSync(filePath));
        saveJsonFile(filePath, defaultData);
    } catch (error) {
        console.error(`Erro ao carregar o arquivo ${filePath}:`, error);
    }
    return defaultData;
}

function saveJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Erro ao salvar o arquivo ${filePath}:`, error);
    }
}

// Carregamento dos dados
let userData = loadJsonFile(ARQUIVO_USUARIOS, {});
let adminData = loadJsonFile(ARQUIVO_ADMINS, {});
let shopData = loadJsonFile(ARQUIVO_DADOS_LOJA, {
    vendasRealizadas: 0,
    faturamentoSemanal: 0,
    faturamentoTotal: 0,
});
let openTickets = loadJsonFile(ARQUIVO_TICKETS, []);
let cartData = loadJsonFile(ARQUIVO_CARRINHOS, {});
let salesAdminData = loadJsonFile(ARQUIVO_VENDEDORES, {});
let pendingOrders = loadJsonFile(ARQUIVO_PEDIDOS, []);
let waitingOrders = loadJsonFile(ARQUIVO_PEDIDOS_ESPERA, []);


if (!adminData[OWNER_JID]) {
    adminData[OWNER_JID] = { atendimentos: 0, status: 'on' };
    saveJsonFile(ARQUIVO_ADMINS, adminData);
}

function generateOrderId() {
    let newId;
    let isUnique = false;
    while (!isUnique) {
        newId = Math.floor(100000 + Math.random() * 900000);
        const existsInPending = pendingOrders.some(order => order.id === newId);
        const existsInWaiting = waitingOrders.some(order => order.id === newId);
        if (!existsInPending && !existsInWaiting) {
            isUnique = true;
        }
    }
    return newId;
}

function goBack(jid) {
    if (
        userState[jid] &&
        userState[jid].history &&
        userState[jid].history.length > 1
    ) {
        userState[jid].history.pop(); // Remove o estado atual
        return userState[jid].history[userState[jid].history.length - 1]; // Retorna o novo último estado
    }
    delete userState[jid]; // Se não houver histórico, limpa o estado
    return null;
}

function navigateTo(jid, step, data = {}) {
    if (!userState[jid]) userState[jid] = { history: [] };
    const currentState = { step, data, timestamp: Date.now() };
    const history = userState[jid].history;

    const lastStep = history.length > 0 ? history[history.length - 1] : null;
    if (!lastStep || lastStep.step !== step) {
        history.push(currentState);
    }
}


function formatRemainingTime(expiryTimestamp) {
    const now = Date.now();
    if (!expiryTimestamp || expiryTimestamp <= now) {
        return "Expirado";
    }

    let delta = Math.floor((expiryTimestamp - now) / 1000);

    const days = Math.floor(delta / 86400);
    delta -= days * 86400;

    const hours = Math.floor(delta / 3600) % 24;
    delta -= hours * 3600;
    const minutes = Math.floor(delta / 60) % 60;

    let remaining = "";
    if (days > 0) remaining += `${days}d `;
    if (hours > 0) remaining += `${hours}h `;
    if (minutes > 0) remaining += `${minutes}m`;

    return remaining.trim();
}

function parseDuration(text) {
    let totalMilliseconds = 0;
    const daysMatch = text.match(/(\d+)\s*d/);
    const hoursMatch = text.match(/(\d+)\s*h/);
    const minutesMatch = text.match(/(\d+)\s*m/);

    if (daysMatch)
        totalMilliseconds += parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
    if (hoursMatch)
        totalMilliseconds += parseInt(hoursMatch[1]) * 60 * 60 * 1000;
    if (minutesMatch)
        totalMilliseconds += parseInt(minutesMatch[1]) * 60 * 1000;
    return totalMilliseconds > 0 ? totalMilliseconds : null;
}

// === MENUS PRINCIPAIS ===

async function sendMainMenu(sock, jid) {
    const userName = userData[jid]?.nome || "Aventureiro(a)";
    const menuCaption = `Olá, *${userName}*! 👋\n\nSeja bem-vindo(a) ao menu principal da *PowerShop*.✨\n\nSinta-se à vontade para explorar nossas opções.`;
    const menuOptions = `\n*1* - 👤 Meu Perfil\n*2* - 🛍️ Comprar Produtos\n*3* - 💬 Dúvidas e Suporte`;
    try {
        if (fs.existsSync(CAMINHO_IMAGEM_MENU)) {
            await sock.sendMessage(jid, {
                image: fs.readFileSync(CAMINHO_IMAGEM_MENU),
                caption: menuCaption + menuOptions,
            });
        } else {
            await sock.sendMessage(jid, { text: menuCaption + menuOptions });
        }
    } catch (e) {
        console.error("Erro ao enviar imagem do menu, enviando apenas texto.", e);
        await sock.sendMessage(jid, { text: menuCaption + menuOptions });
    }
    navigateTo(jid, "awaiting_menu_choice");
}

async function sendProfileView(sock, jid) {
    const profile = userData[jid];
    const totalEconomizado = (profile.totalEconomizado || 0).toFixed(2).replace(".", ",");
    const powerPoints = profile.powerPoints || 0;
    const profileText = `👤 *Seu Perfil, ${profile.nome}*\n\nAqui estão os detalhes da sua jornada conosco:\n\n> 🛍️ Compras realizadas: *${profile.compras}*\n> 💰 Economia total: *R$ ${totalEconomizado}*\n> ✨ PowerPoints: *${powerPoints}*\n> 🎮 Plataforma principal: *${profile.plataforma}*\n\nO que deseja fazer agora?\n*1* - 📝 Alterar meus dados\n*2* - 📜 Histórico de Pedidos\n\n*0* - Voltar ao Menu Principal ↩️`;
    try {
        const pfpUrl = await sock.profilePictureUrl(jid, "image");
        await sock.sendMessage(jid, {
            image: { url: pfpUrl },
            caption: profileText,
        });
    } catch (e) {
        await sock.sendMessage(jid, { text: profileText });
    }
    navigateTo(jid, "awaiting_profile_choice");
}

async function sendBuyMenu(sock, jid) {
    const buyMenuText = `🛍️ *Menu de Compras*\n\nO que você procura em sua aventura hoje?\n\n*1* - ⚡ Ofertas Especiais\n*2* - 🔮 Esferas de Dragão\n*3* - 🐲 Contas Exclusivas\n*4* - 🛒 Meu Carrinho\n\n*0* - Voltar ao menu anterior ↩️`;
    await sock.sendMessage(jid, { text: buyMenuText });
    navigateTo(jid, "awaiting_buy_choice");
}

async function sendEditProfileMenu(sock, jid) {
    const editMenuText = `📝 *Edição de Perfil*\n\nPerfeito!
Qual das suas informações listadas abaixo você gostaria de atualizar?\n\n*1* - 👤 Nome de Usuário\n*2* - 🎮 Plataforma\n\n*0* - Voltar ao seu perfil ↩️`;
    await sock.sendMessage(jid, { text: editMenuText });
    navigateTo(jid, "awaiting_edit_profile_choice");
}

async function sendSupportMenu(sock, jid) {
    const supportText = `💬 *Central de Ajuda e Suporte*\n\nNossa equipe está aqui para te auxiliar.
Como podemos ajudar?\n\n*1* - ❔ Dúvidas Frequentes (FAQ)\n*2* - 👨‍💼 Falar com um Atendente\n\n*0* - Voltar ao menu anterior ↩️`;
    await sock.sendMessage(jid, { text: supportText });
    navigateTo(jid, "awaiting_support_choice");
}

// === FLUXO DE COMPRA E CARRINHO ===

async function sendOfferList(sock, jid) {
    const productFilePath = `${DIRETORIO_PRODUTOS}/ofertas.json`;
    let products = loadJsonFile(productFilePath, []);
    const validProducts = products.filter(
        (p) => !p.expiryTimestamp || p.expiryTimestamp > Date.now(),
    );
    if (validProducts.length === 0) {
        await sock.sendMessage(jid, {
            text: "Sinto muito, não há ofertas especiais disponíveis no momento. Volte em breve!\n\n*0* - Voltar ↩️",
        });
        navigateTo(jid, "awaiting_buy_choice");
        return;
    }

    let menuText = "⚡ *Ofertas Especiais*\n\nConfira nossas ofertas disponíveis. Escolha uma para ver mais detalhes:\n\n";
    validProducts.forEach((product, index) => {
        menuText += `*${index + 1}* - ${product.name}\n`;
    });
    menuText += "\n*0* - Voltar ↩️";

    await sock.sendMessage(jid, { text: menuText });
    navigateTo(jid, "awaiting_offer_choice", { offers: validProducts });
}

async function sendOfferDetails(sock, jid, offer) {
    const user = userData[jid];
    const price = `R$ ${offer.price.toFixed(2).replace(".", ",")}`;
    let caption = `*${offer.name}*\n\n`;
    caption += `${offer.description}\n\n`;
    let platformImage = (offer.images && offer.images[0]) ? offer.images[0] : null;

    // Lógica de economia e imagem específica da plataforma
    if (user && user.plataforma && offer.basePrices) {
        const platformKeyMap = {
            "Android/Play Store": "google",
            "Microsoft/PC": "microsoft",
            "iOS/Apple Store": "ios"
        };
        const platformKey = platformKeyMap[user.plataforma];
        
        if (platformKey && offer.basePrices[platformKey]) {
            const basePrice = offer.basePrices[platformKey];
            const economy = basePrice - offer.price;
            const imageIndex = Object.keys(platformKeyMap).indexOf(user.plataforma);
            platformImage = offer.images[imageIndex] || platformImage;

            const basePriceFormatted = `R$ ${basePrice.toFixed(2).replace(".", ",")}`;
            const economyFormatted = `R$ ${economy.toFixed(2).replace(".", ",")}`;
            
            caption += `*Preço na ${user.plataforma}:* ~${basePriceFormatted}~\n`;
            caption += `*Nosso Preço:* *${price}*\n`;
            if (economy > 0) {
                caption += `*Sua Economia:* *${economyFormatted}* 🤑\n\n`;
            }
        } else {
             caption += `*Valor:* ${price}\n\n`;
        }
    } else {
        caption += `*Valor:* ${price}\n\n`;
    }

    caption += `O que deseja fazer?\n\n`;
    caption += `*1* - 🛒 Adicionar ao Carrinho\n`;
    caption += `*0* - ↩️ Voltar à lista de ofertas`;

    try {
        if (platformImage && fs.existsSync(platformImage)) {
            await sock.sendMessage(jid, {
                image: fs.readFileSync(platformImage),
                caption,
            });
        } else {
            await sock.sendMessage(jid, { text: caption });
        }
    } catch (e) {
        console.error("Falha ao enviar imagem da oferta.", e);
        await sock.sendMessage(jid, { text: caption });
    }
    navigateTo(jid, "awaiting_add_to_cart_confirmation", {
        product: offer,
        type: "oferta",
    });
}


async function sendCartView(sock, jid) {
    const userCart = cartData[jid] || [];
    if (userCart.length === 0) {
        await sock.sendMessage(jid, {
            text: "🛒 *Seu Carrinho*\n\nSeu carrinho de compras está vazio no momento.\n\n*0* - Voltar ↩️",
        });
        navigateTo(jid, "awaiting_buy_choice");
        return;
    }

    let cartText = "🛒 *Seu Carrinho*\n\nEstes são os itens no seu carrinho:\n\n";
    let total = 0;
    userCart.forEach((item, index) => {
        const price = `R$ ${item.price.toFixed(2).replace(".", ",")}`;
        cartText += `*${index + 1}. ${item.name}* - ${price}\n`;
        total += item.price;
    });

    // --- Lógica de Desconto ---
    let finalTotal = total;
    let appliedDiscount = null;
    let nextTier = DISCOUNT_TIERS[0];

    for (let i = DISCOUNT_TIERS.length - 1; i >= 0; i--) {
        if (total >= DISCOUNT_TIERS[i].threshold) {
            appliedDiscount = DISCOUNT_TIERS[i];
            nextTier = DISCOUNT_TIERS[i + 1];
            break;
        }
    }

    cartText += `\n-----------------------------------\n`;
    cartText += `*Subtotal:* R$ ${total.toFixed(2).replace(".", ",")}\n`;

    if (appliedDiscount) {
        finalTotal = total * (1 - appliedDiscount.discount);
        const discountPercentage = Math.round(appliedDiscount.discount * 100);
        cartText += `*Desconto (Compra acima de R$${appliedDiscount.threshold.toFixed(2).replace('.',',')}):* -${discountPercentage}%\n`;
        cartText += `*Total:* *R$ ${finalTotal.toFixed(2).replace(".", ",")}*\n\n`;
    } else {
        cartText += `*Total:* R$ ${total.toFixed(2).replace(".", ",")}\n\n`;
    }

    // --- Barra de Progresso e Mensagem Motivacional ---
    let progressBar = "";
    let motivationalText = "";
    const barLength = 10;

    if (nextTier) {
        const progress = Math.min(barLength, Math.floor((total / nextTier.threshold) * barLength));
        const remaining = nextTier.threshold - total;
        progressBar = `🛍️${'█'.repeat(progress)}${'░'.repeat(barLength - progress)}🎁`;
        motivationalText = `Faltam só R$ ${remaining.toFixed(2).replace(".", ",")} para você desbloquear ${nextTier.message}`;
        if (appliedDiscount) {
            const discountPercentage = Math.round(appliedDiscount.discount * 100);
            motivationalText = `Parabéns! 🎁 Você ganhou ${discountPercentage}% de desconto!\nQue tal um desconto ainda maior? ${motivationalText}`;
        }
    } else { // Atingiu o desconto máximo
        progressBar = `✅${'█'.repeat(barLength)}✅`;
        const maxDiscountPercentage = Math.round(appliedDiscount.discount * 100);
        motivationalText = `INCRÍVEL! 🏆 Você atingiu um desconto de ${maxDiscountPercentage}%!`;
    }

    cartText += `${progressBar}\n${motivationalText}\n\n`;
    cartText += `O que você deseja fazer?\n\n*1* - ✅ Finalizar Compra\n*2* - 🗑️ Esvaziar Carrinho\n\n*0* - Voltar ↩️`;

    await sock.sendMessage(jid, { text: cartText });
    navigateTo(jid, "awaiting_cart_action", { finalTotal });
}


async function handleSuccessfulPayment(sock, jid, total, userCart, facebookLogin, facebookPassword) {
    const totalFormatted = `R$ ${total.toFixed(2).replace(".", ",")}`;
    const clientName = userData[jid]?.nome || jid.split("@")[0];
    const clientNumber = jid.split('@')[0];

    // 1. Criar o objeto do pedido
    const newOrder = {
        id: generateOrderId(),
        clientJid: jid,
        clientName: clientName,
        total: total,
        items: userCart,
        facebookLogin: facebookLogin,
        facebookPassword: facebookPassword,
        timestamp: new Date().toISOString(),
        status: 'pendente', // 'pendente', 'em_processo', 'concluido'
        atendido_por: null
    };

    // 2. Adicionar à lista de pedidos e salvar
    pendingOrders.push(newOrder);
    saveJsonFile(ARQUIVO_PEDIDOS, pendingOrders);

    // 3. Notificar TODOS os Admins com detalhes completos
    const adminJids = Object.keys(adminData);
    if (adminJids.length > 0) {
        let notificationText = `✅ *Nova Venda Registrada para Processamento!* 💰\n\n`;
        notificationText += `*ID do Pedido:* ${newOrder.id}\n`;
        notificationText += `*Cliente:* ${clientName}\n`;
        notificationText += `*Contato:* https://wa.me/${clientNumber}\n`;
        notificationText += `*Login Facebook:* ${facebookLogin}\n`;
        notificationText += `*Senha Facebook:* ${facebookPassword}\n`;
        notificationText += `*Total da Compra:* ${totalFormatted}\n\n`;
        notificationText += `*Itens Adquiridos:*\n`;
        userCart.forEach((item) => {
            notificationText += `> • ${item.name} (R$ ${item.price.toFixed(2).replace(".", ",")})\n`;
        });
        notificationText += `\nEste pedido foi adicionado à fila. Admins de Vendas podem usar o comando /pedidos para processá-lo.`;

        for (const adminJid of adminJids) {
            try {
                await sock.sendMessage(adminJid, { text: notificationText });
            } catch (e) {
                console.error(`Falha ao notificar o admin ${adminJid}:`, e);
            }
        }
    }

    // 4. Atualizar dados da loja e do usuário
    shopData.vendasRealizadas = (shopData.vendasRealizadas || 0) + 1;
    shopData.faturamentoTotal = (shopData.faturamentoTotal || 0) + total;
    saveJsonFile(ARQUIVO_DADOS_LOJA, shopData);

    if (userData[jid]) {
        const user = userData[jid];
        user.compras = (user.compras || 0) + 1;
        
        // Calcular economia e pontos
        let totalEconomy = 0;
        const platformKeyMap = { "Android/Play Store": "google", "Microsoft/PC": "microsoft", "iOS/Apple Store": "ios" };
        const userPlatformKey = platformKeyMap[user.plataforma];

        userCart.forEach(item => {
            if (item.basePrices && item.basePrices[userPlatformKey]) {
                totalEconomy += item.basePrices[userPlatformKey] - item.price;
            }
        });

        user.totalEconomizado = (user.totalEconomizado || 0) + totalEconomy;
        user.powerPoints = (user.powerPoints || 0) + Math.floor(total);
        
        saveJsonFile(ARQUIVO_USUARIOS, userData);
    }

    // 5. Limpar carrinho e estado
    cartData[jid] = [];
    saveJsonFile(ARQUIVO_CARRINHOS, cartData);
    delete userState[jid];
}

async function checkPaymentStatus(sock, jid, paymentId, total, userCart) {
    try {
        console.log(`Verificando status do pagamento: ${paymentId}`);
        const result = await payment.get({ id: paymentId });

        if (result && result.status === 'approved') {
            console.log(`Pagamento ${paymentId} aprovado!`);
            await sock.sendMessage(jid, { text: "✅ Pagamento confirmado com sucesso!" });
            await sock.sendMessage(jid, { text: "Para prosseguir com a entrega, por favor, nos informe o *e-mail ou número* da sua conta do Facebook." });
            navigateTo(jid, 'awaiting_facebook_login', { total, userCart });

        } else if (result && (result.status === 'pending' || result.status === 'in_process')) {
            setTimeout(() => checkPaymentStatus(sock, jid, paymentId, total, userCart), 20000);
        } else {
            console.log(`Pagamento ${paymentId} falhou ou foi cancelado. Status: ${result.status}`);
            await sock.sendMessage(jid, { text: "⚠️ O seu pagamento não foi aprovado ou foi cancelado. Se você acredita que isso é um erro, por favor, entre em contato com o suporte." });
            delete userState[jid];
        }
    } catch (error) {
        console.error("Erro ao verificar status do pagamento:", error);
        await sock.sendMessage(jid, { text: "❌ Ocorreu um erro ao verificar seu pagamento. Por favor, contate o suporte." });
        delete userState[jid];
    }
}


async function startCheckoutProcess(sock, jid, finalTotal) {
    const userCart = cartData[jid] || [];
    if (userCart.length === 0) {
        await sock.sendMessage(jid, { text: "Seu carrinho está vazio." });
        goBack(jid);
        return await sendBuyMenu(sock, jid);
    }
    
    if (!finalTotal || finalTotal <= 0) {
        console.error("Tentativa de checkout com valor inválido:", finalTotal);
        await sock.sendMessage(jid, { text: "❌ Ocorreu um erro com o valor do seu carrinho. Por favor, tente esvaziá-lo e adicionar os itens novamente." });
        return;
    }

    const description = userCart.map(item => item.name).join(', ');

    await sock.sendMessage(jid, { text: "⏳ Um momento, estamos gerando seu pagamento..." });

    try {
        const expirationDate = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('Z', '-03:00'); // 10 minutos de validade

        const createPaymentRequest = {
            body: {
                transaction_amount: Number(finalTotal.toFixed(2)),
                description: `Pedido PowerShop: ${description}`,
                payment_method_id: 'pix',
                payer: {
                    email: `${jid.split('@')[0]}@powershop.com`, // Email de exemplo
                },
                date_of_expiration: expirationDate,
            }
        };

        const createdPayment = await payment.create(createPaymentRequest);
        const paymentData = createdPayment.point_of_interaction.transaction_data;
        const paymentId = createdPayment.id;

        const qrCodeBase64 = paymentData.qr_code_base64;
        const qrCodeCopyPaste = paymentData.qr_code;

        const qrCodeBuffer = Buffer.from(qrCodeBase64, 'base64');

        await sock.sendMessage(jid, {
            image: qrCodeBuffer,
            caption: "✅ Pagamento PIX gerado! Escaneie o QR Code acima para pagar."
        });

        await sock.sendMessage(jid, { text: `Ou use o código Copia e Cola abaixo: 👇` });
        await sock.sendMessage(jid, { text: qrCodeCopyPaste });
        await sock.sendMessage(jid, { text: "Aguardando a confirmação do pagamento... Você será notificado assim que for aprovado. Este código expira em 10 minutos." });

        // Inicia a verificação do status do pagamento
        setTimeout(() => checkPaymentStatus(sock, jid, paymentId, finalTotal, userCart), 20000); // Primeira verificação em 20s

    } catch (error) {
        console.error("!! ERRO AO CRIAR PAGAMENTO NO MERCADO PAGO !!", error);
        await sock.sendMessage(jid, { text: "❌ Desculpe, ocorreu um erro ao gerar seu pagamento. Por favor, tente novamente ou contate o suporte." });
        delete userState[jid];
        await sendMainMenu(sock, jid);
    }
}


// === FLUXO DE COMPRA DE ESFERAS ===

async function sendSpherePurchaseList(sock, jid) {
    const products = loadJsonFile(`${DIRETORIO_PRODUTOS}/esferas.json`, []);
    if (products.length === 0) {
        await sock.sendMessage(jid, {
            text: "Sinto muito, não temos nenhuma esfera de dragão disponível no momento. Volte em breve!\n\n*0* - Voltar ↩️",
        });
        navigateTo(jid, "awaiting_buy_choice");
        return;
    }

    let menuText = "🔮🐉 *Comprar Esferas de Dragão*\n\nNossos dragões esperam por você! Escolha um para ver os detalhes e adquirir suas esferas:\n\n";
    products.forEach((product, index) => {
        menuText += `*${index + 1}* - ${product.name}\n`;
    });
    menuText += "\n*0* - Voltar ↩️";

    await sock.sendMessage(jid, { text: menuText });
    navigateTo(jid, "awaiting_sphere_purchase_choice", { products });
}

async function askForSphereQuantity(sock, jid, product) {
    const minQuantity =
        Math.ceil(100 / product.tradeRatio) * product.tradeRatio;
    let message = `*${product.name}* (${product.rarity})\n\n`;
    message += `Para este dragão, a entrega é feita via trocas em múltiplos de *${product.tradeRatio}* esferas.\n\n`;
    message += `Por favor, informe a quantidade de esferas que você deseja adquirir (mínimo de *${minQuantity}* esferas).\n\n`;
    message += `*0* - Voltar à lista de dragões ↩️`;

    await sock.sendMessage(jid, { text: message });
    navigateTo(jid, "awaiting_sphere_quantity", { product });
}

async function sendSpherePurchaseDetails(
    sock,
    jid,
    product,
    totalSpheres,
    numTrades,
    totalPrice,
) {
    const rarityName = product.rarity.split(" ")[1];
    const priceFormatted = `R$ ${totalPrice.toFixed(2).replace(".", ",")}`;
    let caption = `📝 *Detalhes do seu Pedido*\n\n`;
    caption += `*${product.name}*\n\n`;
    caption += `*Item:* ${totalSpheres} Esferas de Dragão\n`;
    caption += `*Valor:* ${priceFormatted}\n\n`;
    caption += `Para realizar a entrega, os seguintes itens são necessários para a troca no jogo:\n`;
    caption += `> • *${numTrades}* essências de troca de raridade *${rarityName}*.\n`;
    caption += `> • *${totalSpheres}* esferas de qualquer outro dragão de raridade *${rarityName}*.\n\n`;
    caption += `O que deseja fazer?\n`;
    caption += `*1* - ✅ Confirmar e Adicionar ao Carrinho\n`;
    caption += `*2* - 🔢 Alterar Quantidade\n`;
    caption += `*0* - ↩️ Voltar à lista de dragões`;
    try {
        if (product.image && fs.existsSync(product.image)) {
            await sock.sendMessage(jid, {
                image: fs.readFileSync(product.image),
                caption,
            });
        } else {
            await sock.sendMessage(jid, { text: caption });
        }
    } catch (e) {
        console.error("Falha ao enviar imagem do produto para confirmação.", e);
        await sock.sendMessage(jid, { text: caption });
    }

    navigateTo(jid, "awaiting_sphere_purchase_confirmation", {
        product,
        totalSpheres,
        numTrades,
        totalPrice,
    });
}

// === FLUXO DE COMPRA DE CONTAS ===

async function sendAccountList(sock, jid) {
    const productFilePath = `${DIRETORIO_PRODUTOS}/contas.json`;
    const products = loadJsonFile(productFilePath, []);
    if (products.length === 0) {
        await sock.sendMessage(jid, {
            text: "Sinto muito, não há contas disponíveis para venda no momento. Volte em breve!\n\n*0* - Voltar ↩️",
        });
        navigateTo(jid, "awaiting_buy_choice");
        return;
    }

    let menuText = "🐲 *Contas Exclusivas*\n\nConfira nossas contas disponíveis. Escolha uma para ver mais detalhes:\n\n";
    products.forEach((product, index) => {
        menuText += `*${index + 1}* - ${product.name}\n`;
    });
    menuText += "\n*0* - Voltar ↩️";

    await sock.sendMessage(jid, { text: menuText });
    navigateTo(jid, "awaiting_account_choice", { accounts: products });
}

async function sendAccountDetails(sock, jid, account) {
    const price = `R$ ${account.price.toFixed(2).replace(".", ",")}`;
    let caption = `*${account.name}*\n\n`;
    caption += `${account.description}\n\n`;
    caption += `*Valor:* ${price}\n\n`;
    caption += `O que deseja fazer?\n\n`;
    caption += `*1* - 🛒 Adicionar ao Carrinho\n`;
    caption += `*0* - ↩️ Voltar à lista de contas`;
    try {
        if (account.image && fs.existsSync(account.image)) {
            await sock.sendMessage(jid, {
                image: fs.readFileSync(account.image),
                caption,
            });
        } else {
            await sock.sendMessage(jid, { text: caption });
        }
    } catch (e) {
        console.error("Falha ao enviar imagem da conta.", e);
        await sock.sendMessage(jid, { text: caption });
    }
    navigateTo(jid, "awaiting_add_to_cart_confirmation", {
        product: account,
        type: "conta",
    });
}

// === PAINEL DE ADMINISTRAÇÃO ===

async function sendAdminPanel(sock, jid) {
    const adminName = userData[jid]?.nome || "Admin";
    const panelText = `👑 *Painel Administrativo* 👑\n_Olá, ${adminName}! Bem-vindo(a) de volta._\n\nSelecione uma área para gerenciar:\n\n*1* - 📊 Painel de Estatísticas\n*2* - ⚙️ Gerenciar Administradores\n*3* - 🎫 Tickets de Suporte Abertos\n*4* - 📦 Gerenciar Produtos\n*5* - 🤝 Gerenciar Admins de Vendas\n\n*0* - Sair do Painel Admin`;
    await sock.sendMessage(jid, { text: panelText });
    navigateTo(jid, "awaiting_admin_choice");
}

async function sendManageSalesAdminsMenu(sock, jid) {
    let manageText = "🤝 *Gerenciamento de Admins de Vendas* 🤝\n\n_Gerencie os usuários com permissão para realizar vendas._\n\n*Admins de Vendas Atuais:*\n";
    if (Object.keys(salesAdminData).length === 0) {
        manageText += "> Nenhum admin de vendas cadastrado.\n";
    } else {
        for (const salesAdminJid in salesAdminData) {
            const salesAdminUser = userData[salesAdminJid];
            const salesAdminName =
                salesAdminUser?.nome ||
                `Admin de Vendas (${salesAdminJid.split("@")[0]})`;
            const vendas = salesAdminData[salesAdminJid]?.vendas || 0;
            const valorRecebido = (salesAdminData[salesAdminJid]?.valorRecebido || 0).toFixed(2).replace(".", ",");
            manageText += `> • ${salesAdminName} | Vendas: ${vendas} | Valor Recebido: R$ ${valorRecebido}\n`;
        }
    }
    manageText += `\n*1* - ✅ Adicionar Novo Admin de Vendas\n*2* - ❌ Remover Admin de Vendas\n\n*0* - Voltar ao Painel Administrativo ↩️`;
    await sock.sendMessage(jid, { text: manageText });
    navigateTo(jid, "awaiting_manage_sales_admins_choice");
}

async function sendAddSalesAdminPrompt(sock, jid) {
    await sock.sendMessage(jid, { text: "Para adicionar um novo Admin de Vendas, por favor, envie o *número de telefone* dele (com DDI e DDD, ex: 5511912345678)." });
    navigateTo(jid, "awaiting_new_sales_admin_number");
}

async function sendRemoveSalesAdminPrompt(sock, jid) {
    let salesAdminsList = "Para remover um Admin de Vendas, selecione o número correspondente:\n\n";
    const salesAdminsArray = Object.keys(salesAdminData);
    if (salesAdminsArray.length === 0) {
        await sock.sendMessage(jid, { text: "Não há Admins de Vendas para remover." });
        return await sendManageSalesAdminsMenu(sock, jid);
    }
    salesAdminsArray.forEach((salesAdminJid, index) => {
        const salesAdminUser = userData[salesAdminJid];
        const salesAdminName = salesAdminUser?.nome || `Admin de Vendas (${salesAdminJid.split("@")[0]})`;
        salesAdminsList += `*${index + 1}* - ${salesAdminName}\n`;
    });
    salesAdminsList += `\n*0* - Voltar ↩️`;
    await sock.sendMessage(jid, { text: salesAdminsList });
    navigateTo(jid, "awaiting_sales_admin_to_remove_choice", { salesAdmins: salesAdminsArray });
}


async function sendProductCategoryList(sock, jid) {
    const menuText = `📦 *Gerenciamento de Produtos*\n\nSelecione uma categoria para visualizar ou modificar:\n\n*1* - ⚡ Ofertas\n*2* - 🔮 Esferas\n*3* - 🐲 Contas\n\n*0* - Voltar ao Painel Administrativo ↩️`;
    await sock.sendMessage(jid, { text: menuText });
    navigateTo(jid, "awaiting_product_category_list");
}

async function sendProductList(sock, jid, category) {
    const productFilePath = `${DIRETORIO_PRODUTOS}/${category}.json`;
    let products = loadJsonFile(productFilePath, []);
    let productsChanged = false;

    if (category === "ofertas") {
        const totalBefore = products.length;
        const validProducts = products.filter((p) => {
            const isExpired =
                p.expiryTimestamp && p.expiryTimestamp <= Date.now();
            if (isExpired && p.images && p.images.length > 0) {
                p.images.forEach(imgPath => {
                    if (imgPath && fs.existsSync(imgPath)) {
                        console.log(`Removendo imagem de oferta expirada: ${imgPath}`);
                        fs.unlinkSync(imgPath);
                    }
                });
            }
            return !isExpired;
        });
        if (validProducts.length < totalBefore) {
            products = validProducts;
            productsChanged = true;
        }
    }

    let productListText = `--- Lista de Produtos: *${category.toUpperCase()}* ---\n\n`;
    if (products.length === 0) {
        productListText += `Nenhum produto encontrado nesta categoria no momento.`;
    } else {
        products.forEach((product, index) => {
            const price = `R$ ${product.price.toFixed(2).replace(".", ",")}`;
            productListText += `*${index + 1}. ${product.name}*\n`;
            if (product.rarity) {
                productListText += `*Raridade:* ${product.rarity}\n`;
            }

            if (category === "esferas") {
                productListText += `*Preço:* ${price} (por esfera)\n`;
            } else {
                productListText += `*Preço:* ${price}\n`;
            }
            if (product.expiryTimestamp) {
                const remaining = formatRemainingTime(product.expiryTimestamp);
                productListText += `*Expira em:* ${remaining}\n`;
            }
            productListText += `-----------------------------------\n`;
        });
    }

    await sock.sendMessage(jid, { text: productListText });
    if (productsChanged) {
        saveJsonFile(productFilePath, products);
    }

    const menuText = `O que você deseja fazer na categoria *${category.toUpperCase()}*?\n\n*1* - ➕ Adicionar novo produto\n*2* - ✏️ Editar produto existente\n*3* - ➖ Remover produto\n\n*0* - Voltar para a seleção de categorias ↩️`;
    await sock.sendMessage(jid, { text: menuText });
    navigateTo(jid, "awaiting_product_list_action", { category });
}

async function sendProductSelectionMenu(sock, jid, category, action) {
    const productFilePath = `${DIRETORIO_PRODUTOS}/${category}.json`;
    const products = loadJsonFile(productFilePath, []);
    if (products.length === 0) {
        await sock.sendMessage(jid, {
            text: `Não há produtos para ${action} nesta categoria.`,
        });
        goBack(jid);
        return await sendProductList(sock, jid, category);
    }

    const actionTitle = action.charAt(0).toUpperCase() + action.slice(1);
    let menuText = `*${actionTitle} Produto*\n\nVocê está na categoria *${category.toUpperCase()}*. Qual dos produtos abaixo você deseja ${action}?\n\n*Selecione o número correspondente:*\n\n`;
    products.forEach((product, index) => {
        menuText += `*${index + 1}* - ${product.name}\n`;
    });
    menuText += `\n*0* - Voltar à lista de produtos ↩️`;

    await sock.sendMessage(jid, { text: menuText });
    const nextStep =
        action === "editar"
            ? "awaiting_product_to_edit_choice"
            : "awaiting_product_to_remove_choice";
    navigateTo(jid, nextStep, { category, products });
}

async function sendEditAttributeMenu(sock, jid, product, category) {
    const price = `R$ ${product.price.toFixed(2).replace(".", ",")}`;
    let caption =
        `*Editando:* ${product.name}\n\n` +
        `*Descrição:* ${product.description}\n`;
    if (category === "esferas") {
        caption += `*Preço:* ${price} (por esfera)\n`;
    } else {
        caption += `*Preço:* ${price}\n`;
    }

    if (product.rarity) caption += `*Raridade:* ${product.rarity}\n`;
    if (product.expiryTimestamp) {
        const expiryDate = new Date(product.expiryTimestamp);
        const dateString = expiryDate.toLocaleString("pt-BR", {
            timeZone: "America/Sao_Paulo",
        });
        caption += `*Expira em:* ${formatRemainingTime(
            product.expiryTimestamp,
        )} (${dateString})\n`;
    }
    caption +=
        `\nQual atributo você deseja alterar?\n` +
        `*1* - 🏷️ Nome\n*2* - 📄 Descrição\n*3* - 💰 Preço\n*4* - 🖼️ Imagem\n`;
    if (category === "ofertas") {
        caption += `*5* - ⏳ Prazo de Validade\n`;
    }
    caption += `\n*0* - Voltar à seleção de produtos ↩️`;
    try {
        const imagePath = (product.images && product.images[0]) ? product.images[0] : product.image;
        if (imagePath && fs.existsSync(imagePath)) {
            await sock.sendMessage(jid, {
                image: fs.readFileSync(imagePath),
                caption,
            });
        } else {
            await sock.sendMessage(jid, { text: caption });
        }
    } catch (e) {
        console.error(
            `Falha ao enviar imagem do produto ${product.name}, enviando apenas texto.`,
        );
        await sock.sendMessage(jid, { text: caption });
    }
    navigateTo(jid, "awaiting_edit_attribute_choice", { product, category });
}

async function sendOpenTicketsList(sock, jid) {
    if (openTickets.length === 0) {
        await sock.sendMessage(jid, {
            text: "🎉 Excelente! Não há tickets de suporte abertos no momento.\n\n*0* - Voltar ao Painel Administrativo ↩️",
        });
    } else {
        let ticketsListText = `🎫 *Tickets de Suporte Abertos* (${openTickets.length})\n\n`;
        openTickets.forEach((ticket, index) => {
            const messageSnippet = ticket.ticketText
                ? ticket.ticketText.substring(0, 50)
                : "[Mensagem não disponível]";
            const clientContact = ticket.clientJid
                ? ticket.clientJid.split("@")[0]
                : "N/A";

            ticketsListText += `*Ticket ${index + 1}*\n`;
            ticketsListText += `*Cliente:* ${ticket.clientName || "N/A"}\n`;
            ticketsListText += `*Contato:* https://wa.me/${clientContact}\n`;
            ticketsListText += `*Mensagem:* _"${messageSnippet}..."_\n`;
            ticketsListText += `-----------------------------------\n`;
        });
        ticketsListText += `\n*Responda à notificação de um ticket com /f para finalizá-lo.*\n\n*0* - Voltar ↩️`;
        await sock.sendMessage(jid, { text: ticketsListText });
    }
    navigateTo(jid, "sendOpenTicketsList");
}

async function sendManageAdminsMenu(sock, jid) {
    let manageText = "👑 *Gerenciamento de Administradores*\n\n_Apenas o Dono pode adicionar ou remover administradores._\n\n*Administradores Atuais:*\n";
    for (const adminJid in adminData) {
        const adminUser = userData[adminJid];
        const adminName = adminUser?.nome || `Admin (${adminJid.split("@")[0]})`;
        const atendimentos = adminData[adminJid]?.atendimentos || 0;
        const status = adminData[adminJid]?.status === 'on' ? '🟢 Online' : '🔴 Offline';
        manageText += `> • ${adminName} (${atendimentos} atendimentos) - *Status:* ${status}\n`;
    }
    manageText += `\n*1* - ✅ Adicionar Novo Admin\n*2* - ❌ Remover Admin\n\n*Comandos de Status:*\nUse */on* para ficar online e */off* para ficar offline.\n\n*0* - Voltar ao Painel Administrativo ↩️`;
    await sock.sendMessage(jid, { text: manageText });
    navigateTo(jid, "sendManageAdminsMenu");
}

// === LÓGICA DE CONEXÃO E MENSAGENS ===

async function connectToWhatsApp() {
    const { state, saveCreds } =
        await useMultiFileAuthState("auth_info_baileys");
    const sock = makeWASocket({
        logger: pino({ level: "error" }),
        auth: state,
        browser: ["PowerShop Bot", "Chrome", "1.0.0"],
    });
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("QR Code recebido, escaneie com seu celular!");
            qrcodeTerminal.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect =
                (lastDisconnect.error instanceof Boom)?.output?.statusCode !==
                DisconnectReason.loggedOut;
            console.log(
                `Conexão fechada. Motivo: ${lastDisconnect.error}. Reconectando: ${shouldReconnect}`,
            );
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === "open") {
            console.log("Bot online e conectado ao WhatsApp!");
        }
    });
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const userJid = msg.key.remoteJid;
        const messageText = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            ""
        ).trim();

        const isAdmin = adminData.hasOwnProperty(userJid);
        const isSalesAdmin = salesAdminData.hasOwnProperty(userJid);

        // --- Lógica do Chat Direto ---
        if (userState[userJid]?.step === 'in_direct_chat') {
            const { partnerJid, orderId, timeoutId } = userState[userJid].data;
            
            // Limpa o timeout se o cliente responder
            if (!isSalesAdmin && timeoutId) {
                clearTimeout(timeoutId);
                // Inicia um novo timeout
                const newTimeoutId = setTimeout(async () => {
                    const orderIndex = pendingOrders.findIndex(order => order.id === orderId);
                    if (orderIndex !== -1) {
                        const order = pendingOrders[orderIndex];
                        order.status = 'aguardando_cliente';
                        waitingOrders.push(order);
                        pendingOrders.splice(orderIndex, 1);
                        saveJsonFile(ARQUIVO_PEDIDOS, pendingOrders);
                        saveJsonFile(ARQUIVO_PEDIDOS_ESPERA, waitingOrders);

                        delete userState[userJid];
                        delete userState[partnerJid];

                        await sock.sendMessage(userJid, { text: "O tempo de 5 minutos passou. Para que possamos finalizar seu pedido é necessário você estar online para nos aceitar entrar em sua conta.\n\nDeseja sair da lista de espera e ser atendido novamente? Digite *1* para Sim." });
                        navigateTo(userJid, 'awaiting_reactivation');
                        
                        await sock.sendMessage(partnerJid, { text: `O cliente ${order.clientName} ficou offline. O pedido foi movido para a lista de espera. Deseja passar para o próximo?\n\n*1* - Sim\n*2* - Não` });
                        navigateTo(partnerJid, 'awaiting_next_order_choice');
                    }
                }, 5 * 60 * 1000); // 5 minutos
                userState[userJid].data.timeoutId = newTimeoutId;
            }

            if (messageText.toLowerCase() === '/finalizar' && isSalesAdmin) {
                const orderIndex = pendingOrders.findIndex(order => order.id === orderId);
                if (orderIndex !== -1) {
                    const order = pendingOrders[orderIndex];
                    
                    if (!salesAdminData[userJid]) salesAdminData[userJid] = { vendas: 0, valorRecebido: 0 };
                    salesAdminData[userJid].vendas = (salesAdminData[userJid].vendas || 0) + 1;
                    salesAdminData[userJid].valorRecebido = (salesAdminData[userJid].valorRecebido || 0) + order.total;
                    saveJsonFile(ARQUIVO_VENDEDORES, salesAdminData);

                    pendingOrders.splice(orderIndex, 1);
                    saveJsonFile(ARQUIVO_PEDIDOS, pendingOrders);

                    await sock.sendMessage(partnerJid, { text: "✅ Seu atendimento foi finalizado. Agradecemos a sua preferência!" });
                    await sock.sendMessage(userJid, { text: `✅ Atendimento do pedido ${orderId} finalizado com sucesso!` });

                    if (userState[partnerJid]?.data?.timeoutId) {
                        clearTimeout(userState[partnerJid].data.timeoutId);
                    }
                    delete userState[userJid];
                    delete userState[partnerJid];

                    const updatedPendingOrders = pendingOrders.filter(o => o.status === 'pendente');
                    if (updatedPendingOrders.length > 0) {
                        await sock.sendMessage(userJid, { text: `Restam *${updatedPendingOrders.length}* pedidos pendentes. Digite */pedidos* para ver a lista.` });
                    } else {
                        await sock.sendMessage(userJid, { text: "🎉 Todos os pedidos foram processados!" });
                    }
                }
                return;
            }

            const senderName = isSalesAdmin ? "Administrador" : (userData[userJid]?.nome || "Cliente");
            const formattedMessage = `*[ ${senderName} ]*\n${messageText}`;
            await sock.sendMessage(partnerJid, { text: formattedMessage });
            return;
        }


        try {
            if (messageText === "0" && userState[userJid]) {
                const previousState = goBack(userJid);

                if (previousState) {
                    const { step, data } = previousState;
                    const functionMap = {
                        "awaiting_menu_choice": sendMainMenu,
                        "awaiting_profile_choice": sendProfileView,
                        "awaiting_buy_choice": sendBuyMenu,
                        "awaiting_offer_choice": (sock, jid, data) => sendOfferList(sock, jid),
                        "awaiting_add_to_cart_confirmation": (sock, jid, data) => sendOfferDetails(sock, jid, data.product),
                        "awaiting_cart_action": sendCartView,
                        "awaiting_edit_profile_choice": sendEditProfileMenu,
                        "awaiting_support_choice": sendSupportMenu,
                        "awaiting_admin_choice": sendAdminPanel,
                        "awaiting_manage_sales_admins_choice": sendManageSalesAdminsMenu,
                        "awaiting_manage_admins_choice": sendManageAdminsMenu,
                        "awaiting_product_category_list": sendProductCategoryList,
                        "awaiting_product_list_action": (sock, jid, data) => sendProductList(sock, jid, data.category),
                        "awaiting_product_to_edit_choice": (sock, jid, data) => sendProductSelectionMenu(sock, jid, data.category, "editar"),
                        "awaiting_product_to_remove_choice": (sock, jid, data) => sendProductSelectionMenu(sock, jid, data.category, "remover"),
                        "awaiting_edit_attribute_choice": (sock, jid, data) => sendEditAttributeMenu(sock, jid, data.product, data.category),
                        "awaiting_sphere_purchase_choice": (sock, jid) => sendSpherePurchaseList(sock, jid),
                        "awaiting_sphere_quantity": (sock, jid, data) => askForSphereQuantity(sock, jid, data.product),
                        "awaiting_sphere_purchase_confirmation": (sock, jid, data) => sendSpherePurchaseDetails(sock, jid, data.product, data.totalSpheres, data.numTrades, data.totalPrice),
                        "awaiting_account_choice": (sock, jid) => sendAccountList(sock, jid),
                    };

                    if (functionMap[step]) {
                        await functionMap[step](sock, userJid, data);
                    } else {
                        await sendMainMenu(sock, userJid);
                    }
                } else {
                    await sendMainMenu(sock, userJid);
                }
                return;
            }

            if (messageText.startsWith("/")) {
                const [command, ...args] = messageText.split(" ");
                const commandName = command.toLowerCase();

                if (commandName === "/on" && isAdmin) {
                    adminData[userJid].status = 'on';
                    saveJsonFile(ARQUIVO_ADMINS, adminData);
                    await sock.sendMessage(userJid, { text: "✅ Seu status foi definido para *Online*." });
                    return;
                }

                if (commandName === "/off" && isAdmin) {
                    adminData[userJid].status = 'off';
                    saveJsonFile(ARQUIVO_ADMINS, adminData);
                    await sock.sendMessage(userJid, { text: "🔴 Seu status foi definido para *Offline*." });
                    return;
                }

                if (commandName === "/pedidos") {
                    if (!isSalesAdmin) {
                        return await sock.sendMessage(userJid, { text: "🚫 Este comando é restrito para Administradores de Vendas autorizados." });
                    }
                
                    const pendingSaleOrders = pendingOrders.filter(order => order.status === 'pendente');
                    if (pendingSaleOrders.length === 0) {
                        return await sock.sendMessage(userJid, { text: "🎉 Ótimo trabalho! Não há nenhum pedido pendente no momento." });
                    }
                
                    const isAnyAdminOnline = Object.values(adminData).some(admin => admin.status === 'on');
                
                    if (!isAnyAdminOnline) {
                        await sock.sendMessage(userJid, { text: `🚨 Atenção! Existem *${pendingSaleOrders.length}* pedidos pendentes, mas todos os administradores estão offline no momento. Você não pode iniciar uma venda até que um administrador esteja online.` });
                        return;
                    }
                
                    const startMenuText = `Olá! 👋\n\nHá *${pendingSaleOrders.length}* pedido(s) aguardando para serem processados.\n\nO que você deseja fazer?\n\n*1* - Iniciar Venda\n*2* - Sair`;
                    await sock.sendMessage(userJid, { text: startMenuText });
                    navigateTo(userJid, "awaiting_start_sales_choice", { orders: pendingSaleOrders });
                    return;
                }

                if (commandName === "/criar" && isAdmin) {
                    navigateTo(userJid, 'awaiting_create_order_number');
                    await sock.sendMessage(userJid, { text: "Vamos criar um novo pedido manual.\n\nPor favor, envie o *número de telefone do cliente* (com DDI e DDD, ex: 5511912345678)." });
                    return;
                }

                if (commandName === "/aprovar" && isAdmin) {
                    const orderIdToApprove = parseInt(args[0]);
                    if (!orderIdToApprove) {
                        return await sock.sendMessage(userJid, { text: "⚠️ Por favor, especifique o ID do pedido que deseja aprovar. Ex: `/aprovar 123456`" });
                    }
                
                    const orderIndex = pendingOrders.findIndex(order => order.id === orderIdToApprove);
                
                    if (orderIndex === -1) {
                        return await sock.sendMessage(userJid, { text: `❌ Pedido com ID ${orderIdToApprove} não encontrado.` });
                    }
                
                    const order = pendingOrders[orderIndex];
                
                    if (order.paymentGenerated) {
                        return await sock.sendMessage(userJid, { text: `⚠️ Este pedido já teve um pagamento gerado. Aguarde a confirmação automática.` });
                    }
                
                    await sock.sendMessage(order.clientJid, { text: "✅ Boas notícias! Seu pedido foi aprovado manualmente por um administrador." });
                    await sock.sendMessage(order.clientJid, { text: "Para prosseguir com a entrega, por favor, nos informe o *e-mail ou número* da sua conta do Facebook." });
                    navigateTo(order.clientJid, 'awaiting_facebook_login', { total: order.total, userCart: order.items });
                
                    await sock.sendMessage(userJid, { text: `✅ Pedido ${orderIdToApprove} aprovado. O cliente foi notificado para fornecer os dados da conta.` });
                    return;
                }

                if (commandName === "/ativos" && isAdmin) {
                    let activeOrdersText = "📋 *Pedidos Ativos*\n\n";
                    activeOrdersText += "*--- Fila de Atendimento ---*\n";
                    if (pendingOrders.length > 0) {
                        pendingOrders.forEach(order => {
                            activeOrdersText += `*ID:* ${order.id} | *Cliente:* ${order.clientName} | *Status:* ${order.status}\n`;
                        });
                    } else {
                        activeOrdersText += "_Nenhum pedido na fila._\n";
                    }
                    activeOrdersText += "\n*--- Lista de Espera (Offline) ---*\n";
                    if (waitingOrders.length > 0) {
                        waitingOrders.forEach(order => {
                            activeOrdersText += `*ID:* ${order.id} | *Cliente:* ${order.clientName} | *Status:* ${order.status}\n`;
                        });
                    } else {
                        activeOrdersText += "_Nenhum pedido em espera._\n";
                    }
                    await sock.sendMessage(userJid, { text: activeOrdersText });
                    return;
                }

                if (commandName === "/pedido" && isAdmin) {
                    const orderId = parseInt(args[0]);
                    if (!orderId) return await sock.sendMessage(userJid, { text: "Por favor, forneça um ID de pedido. Ex: `/pedido 123456`" });

                    const order = pendingOrders.find(o => o.id === orderId) || waitingOrders.find(o => o.id === orderId);
                    if (!order) return await sock.sendMessage(userJid, { text: `Pedido com ID ${orderId} não encontrado.` });

                    let details = `*Detalhes do Pedido ID: ${order.id}*\n\n`;
                    details += `*Cliente:* ${order.clientName}\n`;
                    details += `*Contato:* https://wa.me/${order.clientJid.split('@')[0]}\n`;
                    details += `*Status:* ${order.status}\n`;
                    if (order.atendido_por) {
                        const salesAdminName = userData[order.atendido_por]?.nome || order.atendido_por.split('@')[0];
                        details += `*Atendido por:* ${salesAdminName}\n`;
                    }
                    details += `*Valor:* R$ ${order.total.toFixed(2).replace('.', ',')}\n`;
                    details += `*Login FB:* ${order.facebookLogin}\n`;
                    details += `*Senha FB:* ${order.facebookPassword}\n\n`;
                    details += "*Itens:*\n";
                    order.items.forEach(item => {
                        details += `> • ${item.name}\n`;
                    });

                    await sock.sendMessage(userJid, { text: details });
                    return;
                }

                if (commandName === "/preferencia" && isAdmin) {
                    const orderId = parseInt(args[0]);
                    if (!orderId) return await sock.sendMessage(userJid, { text: "Por favor, forneça um ID de pedido. Ex: `/preferencia 123456`" });

                    const orderIndex = pendingOrders.findIndex(o => o.id === orderId);
                    if (orderIndex === -1) return await sock.sendMessage(userJid, { text: `Pedido com ID ${orderId} não encontrado na fila pendente.` });

                    const [orderToMove] = pendingOrders.splice(orderIndex, 1);
                    pendingOrders.unshift(orderToMove);
                    saveJsonFile(ARQUIVO_PEDIDOS, pendingOrders);

                    await sock.sendMessage(userJid, { text: `✅ Pedido *${orderId}* movido para o topo da fila com prioridade.` });
                    return;
                }


                if (commandName === "/concluir") {
                    return await sock.sendMessage(userJid, { text: "⚠️ Este comando foi substituído. Para finalizar um atendimento, entre no chat com o cliente e digite */finalizar*." });
                }

                if (commandName === "/cmd") {
                    let cmdText = "📜 *Lista de Comandos Disponíveis*\n\n";
                    cmdText += "*--- Para Todos os Usuários ---*\n";
                    cmdText += "*/p* - Inicia seu cadastro na loja.\n";
                    cmdText += "*/m* - Volta para o menu principal.\n";
                    cmdText += "*/cmd* - Exibe esta lista de comandos.\n\n";
                
                    cmdText += "*--- Para Admins de Vendas ---*\n";
                    cmdText += "*/pedidos* - Mostra os pedidos pendentes e inicia o atendimento.\n";
                    cmdText += "*/finalizar* - (Dentro de um atendimento) Finaliza a venda com o cliente.\n\n";
                
                    cmdText += "*--- Para Administradores ---*\n";
                    cmdText += "*/adm* - Acessa o painel administrativo.\n";
                    cmdText += "*/on* - Define seu status como Online.\n";
                    cmdText += "*/off* - Define seu status como Offline.\n";
                    cmdText += "*/criar* - Cria um novo pedido manualmente.\n";
                    cmdText += "*/ativos* - Lista todos os pedidos em fila e em espera.\n";
                    cmdText += "*/pedido [ID]* - Mostra detalhes de um pedido específico.\n";
                    cmdText += "*/preferencia [ID]* - Dá prioridade a um pedido na fila.\n";
                    cmdText += "*/aprovar [ID]* - Aprova manualmente um pedido criado com o /criar.\n\n";
                
                    cmdText += "*--- Para o Dono ---*\n";
                    cmdText += "*/restart* - ⚠️ Reinicia os dados de usuários, carrinhos e pedidos do bot.\n";
                
                    await sock.sendMessage(userJid, { text: cmdText });
                    return;
                }

                if (commandName === "/restart") {
                    if (userJid !== OWNER_JID) {
                        return await sock.sendMessage(userJid, { text: "🚫 Este comando é restrito ao Dono do bot." });
                    }
                
                    const filesToReset = [
                        { path: ARQUIVO_USUARIOS, default: {} },
                        { path: ARQUIVO_CARRINHOS, default: {} },
                        { path: ARQUIVO_PEDIDOS, default: [] },
                        { path: ARQUIVO_PEDIDOS_ESPERA, default: [] },
                        { path: ARQUIVO_TICKETS, default: [] },
                        { path: ARQUIVO_DADOS_LOJA, default: { vendasRealizadas: 0, faturamentoTotal: 0 } }
                    ];
                
                    filesToReset.forEach(file => {
                        saveJsonFile(file.path, file.default);
                    });
                
                    // Recarregar os dados na memória
                    userData = loadJsonFile(ARQUIVO_USUARIOS, {});
                    cartData = loadJsonFile(ARQUIVO_CARRINHOS, {});
                    pendingOrders = loadJsonFile(ARQUIVO_PEDIDOS, []);
                    waitingOrders = loadJsonFile(ARQUIVO_PEDIDOS_ESPERA, []);
                    openTickets = loadJsonFile(ARQUIVO_TICKETS, []);
                    shopData = loadJsonFile(ARQUIVO_DADOS_LOJA, { vendasRealizadas: 0, faturamentoTotal: 0 });
                
                    await sock.sendMessage(userJid, { text: "✅ *REINICIALIZAÇÃO COMPLETA!*\n\nOs seguintes arquivos foram limpos:\n- Usuários\n- Carrinhos\n- Pedidos\n- Pedidos em Espera\n- Tickets\n- Dados da Loja" });
                    return;
                }

                const finalizeCommands = ["/f", "/finalizar", "/final", "/encerrar"];
                if (finalizeCommands.includes(commandName) && isAdmin) {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quotedMsg) {
                        return await sock.sendMessage(userJid, {
                            text: "⚠️ Para finalizar um atendimento, você precisa *responder* à mensagem de notificação do ticket com o comando /f.",
                        });
                    }

                    const quotedMessageId = msg.message.extendedTextMessage.contextInfo.stanzaId;
                    const ticketIndex = openTickets.findIndex(
                        (t) => t.notificationKeys && t.notificationKeys.some((key) => key.id === quotedMessageId)
                    );

                    if (ticketIndex === -1) {
                        return await sock.sendMessage(userJid, {
                            text: "⚠️ *Ticket não encontrado!*\n\nNão foi possível associar esta mensagem a um ticket de suporte aberto. Por favor, certifique-se de que você está *respondendo* diretamente à mensagem de notificação original enviada pelo bot.",
                        });
                    }

                    const ticketToClose = openTickets[ticketIndex];
                    const clientJid = ticketToClose.clientJid;
                    if (userData[clientJid]) {
                        userData[clientJid].status = "navegando";
                        saveJsonFile(ARQUIVO_USUARIOS, userData);
                    }

                    await sock.sendMessage(clientJid, {
                        text: "✅ Seu atendimento foi finalizado por nossa equipe. Se precisar de algo mais, basta chamar!",
                    });
                    if (!adminData[userJid]) adminData[userJid] = { atendimentos: 0, status: 'on' };
                    adminData[userJid].atendimentos = (adminData[userJid].atendimentos || 0) + 1;
                    saveJsonFile(ARQUIVO_ADMINS, adminData);

                    for (const key of ticketToClose.notificationKeys) {
                        try {
                            await sock.sendMessage(key.remoteJid, { delete: key });
                        } catch (e) {
                            console.error(`Falha ao deletar notificação para ${key.remoteJid}.`);
                        }
                    }

                    openTickets.splice(ticketIndex, 1);
                    saveJsonFile(ARQUIVO_TICKETS, openTickets);
                    await sock.sendMessage(userJid, {
                        text: `Você finalizou o atendimento com *${ticketToClose.clientName}*. Você já realizou *${adminData[userJid].atendimentos}* atendimentos.`,
                    });
                    return;
                }

                if (commandName === "/m") return await sendMainMenu(sock, userJid);
                if (commandName === "/p") {
                    if (userData[userJid])
                        return await sock.sendMessage(userJid, { text: "Você já está registrado! ✅" });

                    await sock.sendMessage(userJid, {
                        text: "Vamos iniciar seu cadastro!\n\nPrimeiro, qual é o seu *nome*?\n_(Você pode alterar isso a qualquer momento no seu perfil)_",
                    });
                    navigateTo(userJid, "register_name");
                    return;
                }

                if (commandName === "/ping")
                    return await sock.sendMessage(userJid, { text: "Pong! 🏓" });

                if (commandName === "/adm") {
                    if (!isAdmin)
                        return await sock.sendMessage(userJid, { text: "🚫 Acesso restrito a administradores." });
                    return await sendAdminPanel(sock, userJid);
                }
                return;
            }

            // Checa se o usuário tem um estado ativo
            if (!userState[userJid] || userState[userJid].history.length === 0) {
                if (userData[userJid]?.status !== 'em_atendimento') {
                    if (!userData[userJid]) {
                         await sock.sendMessage(userJid, {
                            text: "Olá! Vi que você ainda não tem um cadastro. Vamos começar?\n\nPrimeiro, qual é o seu *nome*?",
                        });
                        navigateTo(userJid, "register_name");
                    } else {
                        await sendMainMenu(sock, userJid);
                    }
                }
                return;
            }

            const currentState = userState[userJid].history[
                userState[userJid].history.length - 1
            ];
            if (!currentState) {
                delete userState[userJid];
                return;
            }

            const { step, data } = currentState;
            const isOwner = userJid === OWNER_JID;

            // INICIO DO FLUXO DE ESTADOS
            if (step === "awaiting_facebook_login") {
                const facebookLogin = messageText;
                await sock.sendMessage(userJid, { text: "Ótimo! Agora, por favor, informe a *senha* da sua conta do Facebook." });
                navigateTo(userJid, 'awaiting_facebook_password', { ...data, facebookLogin });
            }
            else if (step === "awaiting_facebook_password") {
                const facebookPassword = messageText;
                const { total, userCart, facebookLogin } = data;
                await sock.sendMessage(userJid, { text: "Obrigado! Sua compra foi registrada e um administrador, que já recebeu seus dados, irá realizar a entrega. Por favor, aguarde." });
                await handleSuccessfulPayment(sock, userJid, total, userCart, facebookLogin, facebookPassword);
            }
            else if (step === "awaiting_start_sales_choice") {
                if (messageText === "1") {
                    const pendingSaleOrders = data.orders;
                    const orderToProcess = pendingSaleOrders[0];
                    const orderIndex = pendingOrders.findIndex(order => order.id === orderToProcess.id);
            
                    if (orderIndex === -1) {
                        await sock.sendMessage(userJid, { text: "❌ Ocorreu um erro ao buscar o pedido. Ele pode já ter sido pego por outro admin de vendas." });
                        delete userState[userJid];
                        return;
                    }
            
                    pendingOrders[orderIndex].status = 'em_processo';
                    pendingOrders[orderIndex].atendido_por = userJid;
                    saveJsonFile(ARQUIVO_PEDIDOS, pendingOrders);
            
                    const buyerName = userData[userJid]?.nome || "Administrador";
                    await sock.sendMessage(orderToProcess.clientJid, { text: `Olá! *${buyerName}* aceitou seu pedido e cuidará da sua entrega. Você pode falar diretamente com ele por aqui.` });
            
                    const timeoutId = setTimeout(async () => {
                        const currentOrderIndex = pendingOrders.findIndex(order => order.id === orderToProcess.id);
                        if (currentOrderIndex !== -1 && pendingOrders[currentOrderIndex].status === 'em_processo') {
                            const order = pendingOrders[currentOrderIndex];
                            order.status = 'aguardando_cliente';
                            waitingOrders.push(order);
                            pendingOrders.splice(currentOrderIndex, 1);
                            saveJsonFile(ARQUIVO_PEDIDOS, pendingOrders);
                            saveJsonFile(ARQUIVO_PEDIDOS_ESPERA, waitingOrders);

                            delete userState[order.clientJid];
                            delete userState[userJid];

                            await sock.sendMessage(order.clientJid, { text: "O tempo de 5 minutos passou. Para que possamos finalizar seu pedido é necessário você estar online para nos aceitar entrar em sua conta.\n\nDeseja sair da lista de espera e ser atendido novamente? Digite *1* para Sim." });
                            navigateTo(order.clientJid, 'awaiting_reactivation');
                            
                            await sock.sendMessage(userJid, { text: `O cliente ${order.clientName} ficou offline. O pedido foi movido para a lista de espera. Deseja passar para o próximo?\n\n*1* - Sim\n*2* - Não` });
                            navigateTo(userJid, 'awaiting_next_order_choice');
                        }
                    }, 5 * 60 * 1000);

                    userState[userJid] = { step: 'in_direct_chat', data: { partnerJid: orderToProcess.clientJid, orderId: orderToProcess.id } };
                    userState[orderToProcess.clientJid] = { step: 'in_direct_chat', data: { partnerJid: userJid, timeoutId: timeoutId } };
            
                    let orderDetailsText = `✅ *Pedido para Processar*\n\n`;
                    orderDetailsText += `*ID do Pedido:* ${orderToProcess.id}\n`;
                    orderDetailsText += `*Cliente:* ${orderToProcess.clientName}\n`;
                    orderDetailsText += `*Contato:* https://wa.me/${orderToProcess.clientJid.split('@')[0]}\n`;
                    orderDetailsText += `*Login Facebook:* \`${orderToProcess.facebookLogin}\`\n`;
                    orderDetailsText += `*Senha Facebook:* \`${orderToProcess.facebookPassword}\`\n\n`;
                    orderDetailsText += `*Itens Adquiridos:*\n`;
                    orderToProcess.items.forEach((item) => {
                        orderDetailsText += `> • ${item.name}\n`;
                    });
                    orderDetailsText += `\n*Você está agora em um chat direto com o cliente.* Para encerrar, digite */finalizar*.`;
            
                    await sock.sendMessage(userJid, { text: orderDetailsText });
            
                } else if (messageText === "2") {
                    await sock.sendMessage(userJid, { text: "Ok, saindo do modo de vendas." });
                    delete userState[userJid];
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, digite 1 ou 2." });
                }
            }
            else if (step === 'awaiting_next_order_choice') {
                if (messageText === '1') {
                    delete userState[userJid];
                    // Simula o comando /pedidos novamente
                    const commandMessage = { ...msg, message: { conversation: '/pedidos' } };
                    sock.ev.emit('messages.upsert', { messages: [commandMessage], type: 'notify' });
                } else if (messageText === '2') {
                    await sock.sendMessage(userJid, { text: "Ok, aguardando. Digite */pedidos* quando quiser ver a fila novamente." });
                    delete userState[userJid];
                } else {
                    await sock.sendMessage(userJid, { text: "Opção inválida. Digite 1 para Sim ou 2 para Não." });
                }
            }
            else if (step === 'awaiting_reactivation') {
                if (messageText === '1') {
                    const orderIndex = waitingOrders.findIndex(order => order.clientJid === userJid);
                    if (orderIndex !== -1) {
                        const order = waitingOrders[orderIndex];
                        order.status = 'pendente';
                        pendingOrders.unshift(order); // Adiciona no início da fila
                        waitingOrders.splice(orderIndex, 1);
                        saveJsonFile(ARQUIVO_PEDIDOS, pendingOrders);
                        saveJsonFile(ARQUIVO_PEDIDOS_ESPERA, waitingOrders);

                        await sock.sendMessage(userJid, { text: "✅ Ótimo! Seu pedido foi reativado e colocado no topo da fila de atendimento." });
                        delete userState[userJid];
                    } else {
                        await sock.sendMessage(userJid, { text: "Não encontrei um pedido em espera para você." });
                        delete userState[userJid];
                    }
                } else {
                    await sock.sendMessage(userJid, { text: "Ok. Seu pedido continuará na lista de espera. Digite 1 quando estiver pronto." });
                }
            }
            else if (step === "register_name") {
                const newName = messageText;
                const platformMenu = `✅ Nome registrado como *${newName}*!\n\nAgora, por favor, informe sua *plataforma principal*:\n\n*1* - Android / Play Store\n*2* - Microsoft / PC\n*3* - iOS / Apple Store`;
                await sock.sendMessage(userJid, { text: platformMenu });
                navigateTo(userJid, "register_platform_choice", { newName });
            } else if (step === "register_platform_choice") {
                const choice = messageText;
                const { newName } = data;
                let newPlatform = "";

                if (choice === "1") {
                    newPlatform = "Android/Play Store";
                } else if (choice === "2") {
                    newPlatform = "Microsoft/PC";
                } else if (choice === "3") {
                    newPlatform = "iOS/Apple Store";
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha 1, 2 ou 3." });
                    return;
                }

                userData[userJid] = {
                    nome: newName,
                    plataforma: newPlatform,
                    compras: 0,
                    totalEconomizado: 0,
                    powerPoints: 0,
                    status: 'navegando'
                };
                saveJsonFile(ARQUIVO_USUARIOS, userData);
                await sock.sendMessage(userJid, { text: "🎉 Cadastro finalizado com sucesso! Seja bem-vindo(a) à PowerShop." });
                delete userState[userJid];
                await sendMainMenu(sock, userJid);
            } else if (step === "awaiting_admin_choice") {
                const stats = loadJsonFile(ARQUIVO_DADOS_LOJA);
                const adminName = userData[userJid]?.nome || "Admin";

                if (messageText === "1") {
                    const totalUsers = Object.keys(userData).length;
                    const panelText = `*📊 PAINEL DE ESTATÍSTICAS*\n_Olá, ${adminName}! Aqui está o resumo atual da loja:_\n\n- - -\n*📈 Vendas Realizadas:* ${stats.vendasRealizadas || 0}\n*💰 Faturamento Total:* R$ ${(stats.faturamentoTotal || 0).toFixed(2).replace(".", ",")}\n*👤 Total de Usuários Registrados:* ${totalUsers}\n- - -\n\n*0* - Voltar ao Painel Administrativo ↩️`;
                    await sock.sendMessage(userJid, { text: panelText });
                    navigateTo(userJid, "awaiting_admin_choice");
                } else if (messageText === "2") {
                    if (!isOwner) {
                        await sock.sendMessage(userJid, { text: "🚫 Apenas o *Dono* pode gerenciar administradores." });
                        return await sendAdminPanel(sock, userJid);
                    }
                    await sendManageAdminsMenu(sock, userJid);
                } else if (messageText === "3") {
                    await sendOpenTicketsList(sock, userJid);
                } else if (messageText === "4") {
                    await sendProductCategoryList(sock, userJid);
                } else if (messageText === "5") {
                    if (!isOwner) {
                        await sock.sendMessage(userJid, { text: "🚫 Apenas o *Dono* pode gerenciar Admins de Vendas." });
                        return await sendAdminPanel(sock, userJid);
                    }
                    await sendManageSalesAdminsMenu(sock, userJid);
                } else if (messageText === "0") {
                    delete userState[userJid];
                    await sendMainMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções do menu." });
                    await sendAdminPanel(sock, userJid);
                }
            } else if (step === "awaiting_manage_sales_admins_choice") {
                if (!isOwner) {
                    await sock.sendMessage(userJid, { text: "🚫 Apenas o *Dono* pode gerenciar Admins de Vendas." });
                    return await sendAdminPanel(sock, userJid);
                }
                if (messageText === "1") {
                    await sendAddSalesAdminPrompt(sock, userJid);
                } else if (messageText === "2") {
                    await sendRemoveSalesAdminPrompt(sock, userJid);
                } else if (messageText === "0") {
                    await sendAdminPanel(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções do menu." });
                    await sendManageSalesAdminsMenu(sock, userJid);
                }
            } else if (step === "awaiting_new_sales_admin_number") {
                if (!isOwner) return;
                const phoneNumber = messageText.replace(/\D/g, ''); // Remove non-digits
                if (!/^\d{10,14}$/.test(phoneNumber)) { // Basic validation for phone number length
                    await sock.sendMessage(userJid, { text: "⚠️ Formato de número inválido. Por favor, envie o número com DDI e DDD (ex: 5511912345678)." });
                    return;
                }
                const newSalesAdminJid = `${phoneNumber}@s.whatsapp.net`;
                if (salesAdminData[newSalesAdminJid]) {
                    await sock.sendMessage(userJid, { text: "⚠️ Este número já está cadastrado como Admin de Vendas." });
                    delete userState[userJid];
                    return await sendManageSalesAdminsMenu(sock, userJid);
                }
                salesAdminData[newSalesAdminJid] = { vendas: 0, valorRecebido: 0 };
                saveJsonFile(ARQUIVO_VENDEDORES, salesAdminData);
                await sock.sendMessage(userJid, { text: `✅ Admin de Vendas *${newSalesAdminJid.split("@")[0]}* adicionado com sucesso!` });
                delete userState[userJid];
                await sendManageSalesAdminsMenu(sock, userJid);
            } else if (step === "awaiting_sales_admin_to_remove_choice") {
                const salesAdminIndex = parseInt(messageText) - 1;
                const salesAdminsArray = data.salesAdmins;
                if (isNaN(salesAdminIndex) || salesAdminIndex < 0 || salesAdminIndex >= salesAdminsArray.length) {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um número da lista." });
                    return;
                }
                const salesAdminJidToRemove = salesAdminsArray[salesAdminIndex];
                delete salesAdminData[salesAdminJidToRemove];
                saveJsonFile(ARQUIVO_VENDEDORES, salesAdminData);
                await sock.sendMessage(userJid, { text: `✅ Admin de Vendas *${salesAdminJidToRemove.split("@")[0]}* removido com sucesso!` });
                delete userState[userJid];
                await sendManageSalesAdminsMenu(sock, userJid);
            } else if (step === "awaiting_menu_choice") {
                if (messageText === "1") {
                    if (userData[userJid]) {
                        await sendProfileView(sock, userJid);
                    } else {
                        await sock.sendMessage(userJid, { text: "Você não possui um perfil registrado. Digite */p* para se cadastrar. ✅" });
                        delete userState[userJid];
                    }
                } else if (messageText === "2") {
                    await sendBuyMenu(sock, userJid);
                } else if (messageText === "3") {
                    await sendSupportMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções do menu principal." });
                    await sendMainMenu(sock, userJid);
                }
            } else if (step === "awaiting_profile_choice") {
                if (messageText === "1") {
                    await sendEditProfileMenu(sock, userJid);
                } else if (messageText === "2") {
                    await sock.sendMessage(userJid, { text: "📜 *Histórico de Pedidos*\n\nDesculpe, o histórico de pedidos ainda não está disponível. Estamos trabalhando para ativá-lo em breve! 🚧\n\n*0* - Voltar ao seu perfil ↩️" });
                    navigateTo(userJid, "awaiting_profile_choice");
                } else if (messageText === "0") {
                    await sendMainMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções do seu perfil." });
                    await sendProfileView(sock, userJid);
                }
            } else if (step === "awaiting_buy_choice") {
                if (messageText === "1") {
                    await sendOfferList(sock, userJid);
                } else if (messageText === "2") {
                    await sendSpherePurchaseList(sock, userJid);
                } else if (messageText === "3") {
                    await sendAccountList(sock, userJid);
                } else if (messageText === "4") {
                    await sendCartView(sock, userJid);
                } else if (messageText === "0") {
                    await sendMainMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções de compra." });
                    await sendBuyMenu(sock, userJid);
                }
            } else if (step === "awaiting_offer_choice") {
                const choice = parseInt(messageText);
                if (!isNaN(choice) && choice > 0 && choice <= data.offers.length) {
                    await sendOfferDetails(sock, userJid, data.offers[choice - 1]);
                } else if (choice === 0) {
                    await sendBuyMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um número da lista de ofertas." });
                    await sendOfferList(sock, userJid);
                }
            } else if (step === "awaiting_add_to_cart_confirmation") {
                if (messageText === "1") {
                    const product = data.product;
                    if (!cartData[userJid]) {
                        cartData[userJid] = [];
                    }
                    cartData[userJid].push(product);
                    saveJsonFile(ARQUIVO_CARRINHOS, cartData);
                    await sock.sendMessage(userJid, {
                        text: `✅ *${product.name}* foi adicionado ao seu carrinho!`,
                    });
                    delete userState[userJid];
                    await sendCartView(sock, userJid);
                } else if (messageText === "0") {
                    if (data.type === "oferta") {
                        await sendOfferList(sock, userJid);
                    } else if (data.type === "esfera") {
                        await sendSpherePurchaseList(sock, userJid);
                    } else if (data.type === "conta") {
                        await sendAccountList(sock, userJid);
                    }
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções." });
                    await sendOfferDetails(sock, userJid, data.product);
                }
            } else if (step === "awaiting_cart_action") {
                if (messageText === "1") {
                    await startCheckoutProcess(sock, userJid, data.finalTotal);
                } else if (messageText === "2") {
                    cartData[userJid] = [];
                    saveJsonFile(ARQUIVO_CARRINHOS, cartData);
                    await sock.sendMessage(userJid, {
                        text: "🛒 Seu carrinho foi esvaziado. ✅",
                    });
                    delete userState[userJid];
                    await sendBuyMenu(sock, userJid);
                } else if (messageText === "0") {
                    await sendBuyMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções do carrinho." });
                    await sendCartView(sock, userJid);
                }
            } else if (step === "awaiting_edit_profile_choice") {
                if (messageText === "1") {
                    navigateTo(userJid, "awaiting_new_name");
                    await sock.sendMessage(userJid, { text: "Por favor, digite seu novo *nome de usuário*:" });
                } else if (messageText === "2") {
                    navigateTo(userJid, "awaiting_new_platform");
                    await sock.sendMessage(userJid, { text: "Por favor, digite sua nova *plataforma principal*:" });
                } else if (messageText === "0") {
                    await sendProfileView(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções de edição de perfil." });
                    await sendEditProfileMenu(sock, userJid);
                }
            } else if (step === "awaiting_new_name") {
                const newName = messageText;
                userData[userJid].nome = newName;
                saveJsonFile(ARQUIVO_USUARIOS, userData);
                await sock.sendMessage(userJid, { text: `✅ Seu nome foi atualizado para *${newName}*!` });
                delete userState[userJid];
                await sendProfileView(sock, userJid);
            } else if (step === "awaiting_new_platform") {
                const newPlatform = messageText;
                userData[userJid].plataforma = newPlatform;
                saveJsonFile(ARQUIVO_USUARIOS, userData);
                await sock.sendMessage(userJid, { text: `✅ Sua plataforma principal foi atualizada para *${newPlatform}*!` });
                delete userState[userJid];
                await sendProfileView(sock, userJid);
            } else if (step === "awaiting_support_choice") {
                if (messageText === "1") {
                    await sock.sendMessage(userJid, { text: "❔ *Dúvidas Frequentes (FAQ)*\n\nDesculpe, nossa seção de FAQ ainda está em construção. Em breve teremos respostas para todas as suas perguntas! 🚧\n\n*0* - Voltar à Central de Ajuda ↩️" });
                    navigateTo(userJid, "awaiting_support_choice");
                } else if (messageText === "2") {
                    if (openTickets.some(t => t.clientJid === userJid)) {
                        await sock.sendMessage(userJid, { text: "⚠️ Você já possui um ticket de atendimento aberto. Nossa equipe entrará em contato em breve. Agradecemos a sua paciência! 😊" });
                        return await sendSupportMenu(sock, userJid);
                    }

                    navigateTo(userJid, "awaiting_support_message");
                    await sock.sendMessage(userJid, { text: "Por favor, descreva sua dúvida ou problema detalhadamente. Quanto mais informações, mais rápido poderemos te ajudar! 💬" });
                } else if (messageText === "0") {
                    await sendMainMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções de suporte." });
                    await sendSupportMenu(sock, userJid);
                }
            } else if (step === "awaiting_support_message") {
                const ticketText = messageText;
                const newTicket = {
                    clientJid: userJid,
                    clientName: userData[userJid]?.nome || userJid.split("@")[0],
                    ticketText: ticketText,
                    timestamp: new Date().toISOString(),
                    notificationKeys: [],
                };
                openTickets.push(newTicket);
                saveJsonFile(ARQUIVO_TICKETS, openTickets);

                await sock.sendMessage(userJid, { text: "✅ Sua mensagem foi enviada à nossa equipe de suporte! Um atendente entrará em contato em breve para te ajudar. Agradecemos a sua paciência! 😊" });
                const adminJids = Object.keys(adminData);
                if (adminJids.length > 0) {
                    let notificationText = `🚨 *NOVO TICKET DE SUPORTE ABERTO* 🚨\n\n`;
                    notificationText += `*Cliente:* ${newTicket.clientName}\n`;
                    notificationText += `*Contato:* https://wa.me/${userJid.split("@")[0]}\n`;
                    notificationText += `*Mensagem:* _"${ticketText}"_\n\n`;
                    notificationText += `Para finalizar este atendimento, responda a esta mensagem com */f*.`;
                    for (const adminJid of adminJids) {
                        try {
                            const sentMsg = await sock.sendMessage(adminJid, { text: notificationText });
                            if (sentMsg?.key) {
                                newTicket.notificationKeys.push(sentMsg.key);
                            }
                        } catch (e) {
                            console.error(`Falha ao notificar o admin ${adminJid} sobre o ticket:`, e);
                        }
                    }
                    saveJsonFile(ARQUIVO_TICKETS, openTickets);
                }
                userData[userJid].status = "em_atendimento";
                saveJsonFile(ARQUIVO_USUARIOS, userData);
                delete userState[userJid];
            } else if (step === "awaiting_product_category_list") {
                if (!isAdmin) {
                    await sock.sendMessage(userJid, { text: "🚫 Acesso restrito a administradores." });
                    return await sendAdminPanel(sock, userJid);
                }
                let category = "";
                if (messageText === "1") category = "ofertas";
                else if (messageText === "2") category = "esferas";
                else if (messageText === "3") category = "contas";
                else if (messageText === "0") {
                    await sendAdminPanel(sock, userJid);
                    return;
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma categoria de produto válida." });
                    return await sendProductCategoryList(sock, userJid);
                }
                await sendProductList(sock, userJid, category);
            } else if (step === "awaiting_product_list_action") {
                if (!isAdmin) {
                    await sock.sendMessage(userJid, { text: "🚫 Acesso restrito a administradores." });
                    return await sendAdminPanel(sock, userJid);
                }
                const category = data.category;
                if (messageText === "1") {
                    navigateTo(userJid, "awaiting_new_product_name", { category });
                    await sock.sendMessage(userJid, { text: `Para adicionar um novo produto na categoria *${category.toUpperCase()}*, por favor, digite o *nome* do produto:` });
                } else if (messageText === "2") {
                    await sendProductSelectionMenu(sock, userJid, category, "editar");
                } else if (messageText === "3") {
                    await sendProductSelectionMenu(sock, userJid, category, "remover");
                } else if (messageText === "0") {
                    await sendProductCategoryList(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma ação válida." });
                    await sendProductList(sock, userJid, category);
                }
            } else if (step === "awaiting_new_product_name") {
                if (!isAdmin) return;
                const newProductName = messageText;
                navigateTo(userJid, "awaiting_new_product_description", { ...data, newProductName });
                await sock.sendMessage(userJid, { text: `Nome: *${newProductName}*. Agora, por favor, digite a *descrição* do produto:` });
            } else if (step === "awaiting_new_product_description") {
                if (!isAdmin) return;
                const newProductDescription = messageText;
                const currentData = { ...data, newProductDescription };

                if (data.category === 'ofertas') {
                    navigateTo(userJid, "awaiting_new_product_price_sell", currentData);
                    await sock.sendMessage(userJid, { text: `Descrição adicionada. Agora, por favor, digite o *preço de venda* da oferta (ex: 19.99):` });
                } else { // Old flow for 'contas' and 'esferas'
                    navigateTo(userJid, "awaiting_new_product_price", currentData);
                    await sock.sendMessage(userJid, { text: `Descrição: *${newProductDescription}*. Agora, por favor, digite o *preço* do produto (ex: 19.99):` });
                }
            } else if (step === "awaiting_new_product_price") { // OLD FLOW FOR NON-OFFERS
                if (!isAdmin) return;
                const newProductPrice = parseFloat(messageText.replace(",", "."));
                if (isNaN(newProductPrice) || newProductPrice <= 0) {
                    await sock.sendMessage(userJid, { text: "⚠️ Preço inválido. Por favor, digite um número maior que zero (ex: 19.99)." });
                    return;
                }
                const currentProductData = { ...data, newProductPrice };
                if (data.category === "esferas") {
                    navigateTo(userJid, "awaiting_sphere_rarity", currentProductData);
                    await sock.sendMessage(userJid, { text: `Preço: R$ ${newProductPrice.toFixed(2).replace(",", ".")}. Agora, por favor, digite a *raridade* da esfera (ex: Comum, Raro, Lendário):` });
                } else { // This will now only be for 'contas'
                    navigateTo(userJid, "awaiting_product_image", { ...currentProductData });
                    await sock.sendMessage(userJid, { text: `Preço: R$ ${newProductPrice.toFixed(2).replace(",", ".")}. Agora, por favor, envie a *imagem* do produto (ou digite 'pular' para não adicionar imagem):` });
                }
            } else if (step === "awaiting_new_product_price_sell") { // NEW FLOW FOR OFFERS
                if (!isAdmin) return;
                const sellPrice = parseFloat(messageText.replace(",", "."));
                if (isNaN(sellPrice) || sellPrice <= 0) {
                    await sock.sendMessage(userJid, { text: "⚠️ Preço de venda inválido. Por favor, digite um número maior que zero (ex: 19.99)." });
                    return;
                }
                navigateTo(userJid, "awaiting_new_product_price_ios", { ...data, sellPrice });
                await sock.sendMessage(userJid, { text: `Preço de venda: R$ ${sellPrice.toFixed(2).replace(",", ".")}. Agora, digite o preço base para *iOS / Apple Store*:` });
            }
            else if (step === "awaiting_new_product_price_ios") {
                if (!isAdmin) return;
                const iosPrice = parseFloat(messageText.replace(",", "."));
                if (isNaN(iosPrice) || iosPrice < 0) {
                    await sock.sendMessage(userJid, { text: "⚠️ Preço inválido. Por favor, digite um número." });
                    return;
                }
                navigateTo(userJid, "awaiting_new_product_price_google", { ...data, iosPrice });
                await sock.sendMessage(userJid, { text: `Preço iOS: R$ ${iosPrice.toFixed(2).replace(",", ".")}. Agora, digite o preço base para *Android / Google Play*:` });
            }
            else if (step === "awaiting_new_product_price_google") {
                if (!isAdmin) return;
                const googlePrice = parseFloat(messageText.replace(",", "."));
                if (isNaN(googlePrice) || googlePrice < 0) {
                    await sock.sendMessage(userJid, { text: "⚠️ Preço inválido. Por favor, digite um número." });
                    return;
                }
                navigateTo(userJid, "awaiting_new_product_price_microsoft", { ...data, googlePrice });
                await sock.sendMessage(userJid, { text: `Preço Google Play: R$ ${googlePrice.toFixed(2).replace(",", ".")}. Agora, digite o preço base para *Microsoft / PC*:` });
            }
            else if (step === "awaiting_new_product_price_microsoft") {
                if (!isAdmin) return;
                const microsoftPrice = parseFloat(messageText.replace(",", "."));
                if (isNaN(microsoftPrice) || microsoftPrice < 0) {
                    await sock.sendMessage(userJid, { text: "⚠️ Preço inválido. Por favor, digite um número." });
                    return;
                }
                navigateTo(userJid, "awaiting_offer_expiry", { ...data, microsoftPrice });
                await sock.sendMessage(userJid, { text: `Preço Microsoft: R$ ${microsoftPrice.toFixed(2).replace(",", ".")}. Agora, digite o *prazo de validade* (ex: 7d, 24h, 30m) ou digite 'pular' para não definir uma validade:` });
            }
            else if (step === "awaiting_sphere_rarity") {
                if (!isAdmin) return;
                const rarity = messageText;
                navigateTo(userJid, "awaiting_sphere_trade_ratio", { ...data, rarity });
                await sock.sendMessage(userJid, { text: `Raridade: *${rarity}*. Agora, por favor, digite a *proporção de troca* para este tipo de esfera (um número inteiro, ex: 50 para trocas de 50 em 50):` });
            } else if (step === "awaiting_sphere_trade_ratio") {
                if (!isAdmin) return;
                const tradeRatio = parseInt(messageText);
                if (isNaN(tradeRatio) || tradeRatio <= 0) {
                    await sock.sendMessage(userJid, { text: "⚠️ Proporção de troca inválida. Por favor, digite um número inteiro maior que zero." });
                    return;
                }
                const newProduct = {
                    id: Date.now().toString(),
                    name: data.newProductName,
                    description: data.newProductDescription,
                    price: data.newProductPrice,
                    rarity: data.rarity,
                    tradeRatio: tradeRatio,
                };
                const productFilePath = `${DIRETORIO_PRODUTOS}/${data.category}.json`;
                const currentProducts = loadJsonFile(productFilePath, []);
                currentProducts.push(newProduct);
                saveJsonFile(productFilePath, currentProducts);
                await sock.sendMessage(userJid, {
                    text: `✅ Esfera *"${newProduct.name}"* adicionada com sucesso!`,
                });
                delete userState[userJid];
                await sendAdminPanel(sock, userJid);
            } else if (step === "awaiting_offer_expiry") {
                if (!isAdmin) return;
                let expiryTimestamp = null;
                if (messageText.toLowerCase() !== 'pular') {
                    const durationMs = parseDuration(messageText);
                    if (!durationMs) {
                        await sock.sendMessage(userJid, { text: "⚠️ Prazo de validade inválido. Por favor, use formatos como '7d', '24h', '30m' ou 'pular'." });
                        return;
                    }
                    expiryTimestamp = Date.now() + durationMs;
                }
                
                navigateTo(userJid, "awaiting_product_image_1", { ...data, expiryTimestamp, imagePaths: [] });
                await sock.sendMessage(userJid, { text: `Prazo de validade definido. Agora, por favor, envie a *primeira imagem* (para iOS). Você pode pular o envio de qualquer imagem digitando 'pular'.` });
            }
            else if (step === "awaiting_product_image_1") {
                if (!isAdmin) return;
                let newImagePath = "";
                if (msg.message.imageMessage) {
                    const buffer = await downloadMediaMessage(msg, "buffer");
                    const fileName = `${Date.now()}_1_ios_${userJid.split("@")[0]}.jpeg`;
                    newImagePath = `${DIRETORIO_MEDIA}/${fileName}`;
                    fs.writeFileSync(newImagePath, buffer);
                    await sock.sendMessage(userJid, { text: "✅ Primeira imagem (iOS) recebida!" });
                } else {
                    await sock.sendMessage(userJid, { text: "🖼️ Imagem ignorada." });
                }
                data.imagePaths.push(newImagePath);
                navigateTo(userJid, "awaiting_product_image_2", data);
                await sock.sendMessage(userJid, { text: `Agora, envie a *segunda imagem* (para Android/Google Play).` });
            }
            else if (step === "awaiting_product_image_2") {
                if (!isAdmin) return;
                let newImagePath = "";
                if (msg.message.imageMessage) {
                    const buffer = await downloadMediaMessage(msg, "buffer");
                    const fileName = `${Date.now()}_2_google_${userJid.split("@")[0]}.jpeg`;
                    newImagePath = `${DIRETORIO_MEDIA}/${fileName}`;
                    fs.writeFileSync(newImagePath, buffer);
                    await sock.sendMessage(userJid, { text: "✅ Segunda imagem (Google Play) recebida!" });
                } else {
                    await sock.sendMessage(userJid, { text: "🖼️ Imagem ignorada." });
                }
                data.imagePaths.push(newImagePath);
                navigateTo(userJid, "awaiting_product_image_3", data);
                await sock.sendMessage(userJid, { text: `Agora, envie a *terceira e última imagem* (para Microsoft/PC).` });
            }
            else if (step === "awaiting_product_image_3") {
                if (!isAdmin) return;
                let newImagePath = "";
                if (msg.message.imageMessage) {
                    const buffer = await downloadMediaMessage(msg, "buffer");
                    const fileName = `${Date.now()}_3_microsoft_${userJid.split("@")[0]}.jpeg`;
                    newImagePath = `${DIRETORIO_MEDIA}/${fileName}`;
                    fs.writeFileSync(newImagePath, buffer);
                    await sock.sendMessage(userJid, { text: "✅ Terceira imagem (Microsoft) recebida!" });
                } else {
                    await sock.sendMessage(userJid, { text: "🖼️ Imagem ignorada." });
                }
                data.imagePaths.push(newImagePath);

                const newProduct = {
                    id: Date.now().toString(),
                    name: data.newProductName,
                    description: data.newProductDescription,
                    price: data.sellPrice,
                    basePrices: {
                        ios: data.iosPrice,
                        google: data.googlePrice,
                        microsoft: data.microsoftPrice,
                    },
                    images: data.imagePaths.filter(p => p !== ""), // Remove empty paths if user skipped
                    expiryTimestamp: data.expiryTimestamp, // Will be null if skipped
                };
                
                const productFilePath = `${DIRETORIO_PRODUTOS}/${data.category}.json`;
                const currentProducts = loadJsonFile(productFilePath, []);
                currentProducts.push(newProduct);
                saveJsonFile(productFilePath, currentProducts);
                await sock.sendMessage(userJid, {
                    text: `✅ Oferta *"${newProduct.name}"* adicionada com sucesso!`,
                });
                delete userState[userJid];
                await sendAdminPanel(sock, userJid);
            }
            else if (step === "awaiting_product_image") { // OLD SINGLE-IMAGE STEP FOR 'CONTAS'
                if (!isAdmin) return;
                let newImagePath = "";
                if (msg.message.imageMessage) {
                    const buffer = await downloadMediaMessage(msg, "buffer");
                    const fileName = `${Date.now()}_${userJid.split("@")[0]}.jpeg`;
                    newImagePath = `${DIRETORIO_MEDIA}/${fileName}`;
                    fs.writeFileSync(newImagePath, buffer);
                    await sock.sendMessage(userJid, { text: "✅ Imagem recebida!" });
                } else if (messageText.toLowerCase() === "pular") {
                    await sock.sendMessage(userJid, { text: "🖼️ Imagem ignorada." });
                } else {
                    await sock.sendMessage(userJid, { text: "⚠️ Por favor, envie uma imagem ou digite 'pular'." });
                    return;
                }
                const newProduct = {
                    id: Date.now().toString(),
                    name: data.newProductName,
                    description: data.newProductDescription,
                    price: data.newProductPrice,
                    image: newImagePath, // Single image
                };
                const productFilePath = `${DIRETORIO_PRODUTOS}/${data.category}.json`;
                const currentProducts = loadJsonFile(productFilePath, []);
                currentProducts.push(newProduct);
                saveJsonFile(productFilePath, currentProducts);
                await sock.sendMessage(userJid, {
                    text: `✅ Produto *"${newProduct.name}"* adicionado com sucesso!`,
                });
                delete userState[userJid];
                await sendAdminPanel(sock, userJid);
            } else if (step === "awaiting_product_to_edit_choice") {
                if (!isAdmin) return;
                const choice = parseInt(messageText);
                const products = data.products;
                if (!isNaN(choice) && choice > 0 && choice <= products.length) {
                    const productToEdit = products[choice - 1];
                    navigateTo(userJid, "awaiting_edit_attribute_choice", { product: productToEdit, category: data.category, productIndex: choice - 1 });
                    await sendEditAttributeMenu(sock, userJid, productToEdit, data.category);
                } else if (choice === 0) {
                    await sendProductList(sock, userJid, data.category);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um número da lista." });
                    await sendProductSelectionMenu(sock, userJid, data.category, "editar");
                }
            } else if (step === "awaiting_edit_attribute_choice") {
                if (!isAdmin) return;
                const { product, category, productIndex } = data;
                if (messageText === "1") {
                    navigateTo(userJid, "awaiting_new_product_name_edit", { product, category, productIndex });
                    await sock.sendMessage(userJid, { text: `Digite o novo *nome* para "${product.name}":` });
                } else if (messageText === "2") {
                    navigateTo(userJid, "awaiting_new_product_description_edit", { product, category, productIndex });
                    await sock.sendMessage(userJid, { text: `Digite a nova *descrição* para "${product.name}":` });
                } else if (messageText === "3") {
                    navigateTo(userJid, "awaiting_new_product_price_edit", { product, category, productIndex });
                    await sock.sendMessage(userJid, { text: `Digite o novo *preço* para "${product.name}" (ex: 19.99):` });
                } else if (messageText === "4") {
                    navigateTo(userJid, "awaiting_product_image_edit", { product, category, productIndex });
                    await sock.sendMessage(userJid, { text: `Envie a nova *imagem* para "${product.name}" (ou digite 'manter' para não alterar, ou 'remover' para remover a imagem atual):` });
                } else if (messageText === "5" && category === "ofertas") {
                    navigateTo(userJid, "awaiting_offer_expiry_edit", { product, category, productIndex });
                    await sock.sendMessage(userJid, { text: `Digite o novo *prazo de validade* para "${product.name}" (ex: 7d, 24h, 30m, ou 'remover' para remover a validade):` });
                } else if (messageText === "0") {
                    await sendProductSelectionMenu(sock, userJid, category, "editar");
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um atributo para editar." });
                    await sendEditAttributeMenu(sock, userJid, product, category);
                }
            } else if (step === "awaiting_new_product_name_edit") {
                if (!isAdmin) return;
                const newName = messageText;
                const { category, productIndex } = data;
                const productFilePath = `${DIRETORIO_PRODUTOS}/${category}.json`;
                let currentProducts = loadJsonFile(productFilePath, []);
                currentProducts[productIndex].name = newName;
                saveJsonFile(productFilePath, currentProducts);
                await sock.sendMessage(userJid, { text: `✅ Nome do produto atualizado para *${newName}*!` });
                delete userState[userJid];
                await sendProductList(sock, userJid, category);
            } else if (step === "awaiting_new_product_description_edit") {
                if (!isAdmin) return;
                const newDescription = messageText;
                const { category, productIndex } = data;
                const productFilePath = `${DIRETORIO_PRODUTOS}/${category}.json`;
                let currentProducts = loadJsonFile(productFilePath, []);
                currentProducts[productIndex].description = newDescription;
                saveJsonFile(productFilePath, currentProducts);
                await sock.sendMessage(userJid, { text: `✅ Descrição do produto atualizada!` });
                delete userState[userJid];
                await sendProductList(sock, userJid, category);
            } else if (step === "awaiting_new_product_price_edit") {
                if (!isAdmin) return;
                const newPrice = parseFloat(messageText.replace(",", "."));
                if (isNaN(newPrice) || newPrice <= 0) {
                    await sock.sendMessage(userJid, { text: "⚠️ Preço inválido. Por favor, digite um número maior que zero (ex: 19.99)." });
                    return;
                }
                const { category, productIndex } = data;
                const productFilePath = `${DIRETORIO_PRODUTOS}/${category}.json`;
                let currentProducts = loadJsonFile(productFilePath, []);
                currentProducts[productIndex].price = newPrice;
                saveJsonFile(productFilePath, currentProducts);
                await sock.sendMessage(userJid, { text: `✅ Preço do produto atualizado para R$ ${newPrice.toFixed(2).replace(",", ".")}.` });
                delete userState[userJid];
                await sendProductList(sock, userJid, category);
            } else if (step === "awaiting_product_image_edit") {
                if (!isAdmin) return;
                const { product, category, productIndex } = data;
                const productFilePath = `${DIRETORIO_PRODUTOS}/${category}.json`;
                let currentProducts = loadJsonFile(productFilePath, []);
                let newImagePath = product.image || "";

                if (msg.message.imageMessage) {
                    const buffer = await downloadMediaMessage(msg, "buffer");
                    if (newImagePath && fs.existsSync(newImagePath)) {
                        fs.unlinkSync(newImagePath);
                    }
                    const fileName = `${Date.now()}_${userJid.split("@")[0]}.jpeg`;
                    newImagePath = `${DIRETORIO_MEDIA}/${fileName}`;
                    fs.writeFileSync(newImagePath, buffer);
                    await sock.sendMessage(userJid, { text: "✅ Nova imagem recebida e atualizada!" });
                } else if (messageText.toLowerCase() === "remover") {
                    if (newImagePath && fs.existsSync(newImagePath)) {
                        fs.unlinkSync(newImagePath);
                    }
                    newImagePath = "";
                    await sock.sendMessage(userJid, { text: "🗑️ Imagem atual removida." });
                } else if (messageText.toLowerCase() === "manter") {
                    await sock.sendMessage(userJid, { text: "🖼️ Imagem atual mantida." });
                } else {
                    await sock.sendMessage(userJid, { text: "⚠️ Por favor, envie uma imagem, digite 'manter' ou 'remover'." });
                    return;
                }
                currentProducts[productIndex].image = newImagePath;
                saveJsonFile(productFilePath, currentProducts);
                delete userState[userJid];
                await sendProductList(sock, userJid, category);
            } else if (step === "awaiting_offer_expiry_edit") {
                if (!isAdmin) return;
                const { category, productIndex } = data;
                const productFilePath = `${DIRETORIO_PRODUTOS}/${category}.json`;
                let currentProducts = loadJsonFile(productFilePath, []);
                let newExpiryTimestamp = null;

                if (messageText.toLowerCase() === "remover") {
                    await sock.sendMessage(userJid, { text: "⏳ Prazo de validade removido." });
                } else {
                    const durationMs = parseDuration(messageText);
                    if (!durationMs) {
                        await sock.sendMessage(userJid, { text: "⚠️ Prazo de validade inválido. Por favor, use formatos como '7d', '24h', '30m' ou 'remover'." });
                        return;
                    }
                    newExpiryTimestamp = Date.now() + durationMs;
                    await sock.sendMessage(userJid, { text: `✅ Prazo de validade atualizado para ${formatRemainingTime(newExpiryTimestamp)}.` });
                }
                currentProducts[productIndex].expiryTimestamp = newExpiryTimestamp;
                saveJsonFile(productFilePath, currentProducts);
                delete userState[userJid];
                await sendProductList(sock, userJid, category);
            } else if (step === "awaiting_product_to_remove_choice") {
                if (!isAdmin) return;
                const choice = parseInt(messageText);
                const products = data.products;
                if (!isNaN(choice) && choice > 0 && choice <= products.length) {
                    const removedProduct = products.splice(choice - 1, 1)[0];
                    const productFilePath = `${DIRETORIO_PRODUTOS}/${data.category}.json`;
                    saveJsonFile(productFilePath, products);

                    if (removedProduct.image && fs.existsSync(removedProduct.image)) {
                        fs.unlinkSync(removedProduct.image);
                    }

                    await sock.sendMessage(userJid, {
                        text: `✅ Produto *"${removedProduct.name}"* removido com sucesso!`,
                    });
                    delete userState[userJid];
                    await sendProductList(sock, userJid, data.category);
                } else if (choice === 0) {
                    await sendProductList(sock, userJid, data.category);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um número da lista." });
                    await sendProductSelectionMenu(sock, userJid, data.category, "remover");
                }
            } else if (step === "awaiting_manage_admins_choice") {
                if (!isOwner) {
                    await sock.sendMessage(userJid, { text: "🚫 Apenas o *Dono* pode gerenciar administradores." });
                    return await sendAdminPanel(sock, userJid);
                }
                if (messageText === "1") {
                    navigateTo(userJid, "awaiting_new_admin_number");
                    await sock.sendMessage(userJid, { text: "Por favor, envie o *número de telefone* do novo administrador (com DDI e DDD, ex: 5511912345678)." });
                } else if (messageText === "2") {
                    navigateTo(userJid, "awaiting_admin_to_remove_choice", { admins: Object.keys(adminData).filter(jid => jid !== OWNER_JID) });
                    let adminList = "Para remover um administrador, selecione o número correspondente:\n\n";
                    const removableAdmins = Object.keys(adminData).filter(jid => jid !== OWNER_JID);
                    if (removableAdmins.length === 0) {
                        await sock.sendMessage(userJid, { text: "Não há outros administradores para remover." });
                        return await sendManageAdminsMenu(sock, userJid);
                    }
                    removableAdmins.forEach((adminJid, index) => {
                        const adminUser = userData[adminJid];
                        const adminName = adminUser?.nome || `Admin (${adminJid.split("@")[0]})`;
                        adminList += `*${index + 1}* - ${adminName}\n`;
                    });
                    adminList += `\n*0* - Voltar ao gerenciamento de administradores ↩️`;
                    await sock.sendMessage(userJid, { text: adminList });
                } else if (messageText === "0") {
                    await sendAdminPanel(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções." });
                    await sendManageAdminsMenu(sock, userJid);
                }
            } else if (step === "awaiting_new_admin_number") {
                if (!isOwner) return;
                const phoneNumber = messageText.replace(/\D/g, ''); // Remove non-digits
                if (!/^\d{10,14}$/.test(phoneNumber)) { // Basic validation for phone number length
                    await sock.sendMessage(userJid, { text: "⚠️ Formato de número inválido. Por favor, envie o número com DDI e DDD (ex: 5511912345678)." });
                    return;
                }
                const newAdminJid = `${phoneNumber}@s.whatsapp.net`;
                if (adminData[newAdminJid]) {
                    await sock.sendMessage(userJid, { text: "⚠️ Este número já está cadastrado como administrador." });
                    delete userState[userJid];
                    return await sendManageAdminsMenu(sock, userJid);
                }
                adminData[newAdminJid] = { atendimentos: 0, status: 'on' };
                saveJsonFile(ARQUIVO_ADMINS, adminData);
                await sock.sendMessage(userJid, { text: `✅ Administrador *${newAdminJid.split("@")[0]}* adicionado com sucesso!` });
                delete userState[userJid];
                await sendManageAdminsMenu(sock, userJid);
            } else if (step === "awaiting_admin_to_remove_choice") {
                if (!isOwner) return;
                const choice = parseInt(messageText) - 1;
                const removableAdmins = data.admins;
                if (isNaN(choice) || choice < 0 || choice >= removableAdmins.length) {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um número da lista." });
                    return;
                }
                const adminJidToRemove = removableAdmins[choice];
                if (adminJidToRemove === OWNER_JID) {
                    await sock.sendMessage(userJid, { text: "🚫 Você não pode remover o JID do Dono!" });
                    return await sendManageAdminsMenu(sock, userJid);
                }
                delete adminData[adminJidToRemove];
                saveJsonFile(ARQUIVO_ADMINS, adminData);
                await sock.sendMessage(userJid, { text: `✅ Administrador *${adminJidToRemove.split("@")[0]}* removido com sucesso!` });
                delete userState[userJid];
                await sendManageAdminsMenu(sock, userJid);
            } else if (step === "awaiting_sphere_purchase_choice") {
                const choice = parseInt(messageText);
                if (!isNaN(choice) && choice > 0 && choice <= data.products.length) {
                    const chosenProduct = data.products[choice - 1];
                    await askForSphereQuantity(sock, userJid, chosenProduct);
                } else if (choice === 0) {
                    await sendBuyMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um número da lista de dragões." });
                    await sendSpherePurchaseList(sock, userJid);
                }
            } else if (step === "awaiting_sphere_quantity") {
                const quantity = parseInt(messageText);
                const product = data.product;
                const minQuantity = Math.ceil(100 / product.tradeRatio) * product.tradeRatio;
                if (isNaN(quantity) || quantity < minQuantity || quantity % product.tradeRatio !== 0) {
                    await sock.sendMessage(userJid, {
                        text: `⚠️ Quantidade inválida. Por favor, informe um número válido (mínimo ${minQuantity}) e múltiplo de ${product.tradeRatio}.\n\n*0* - Voltar à lista de dragões ↩️`,
                    });
                    return;
                }
                const numTrades = quantity / product.tradeRatio;
                const totalPrice = numTrades * product.price;

                await sendSpherePurchaseDetails(sock, userJid, product, quantity, numTrades, totalPrice);
            } else if (step === "awaiting_sphere_purchase_confirmation") {
                if (messageText === "1") {
                    const product = data.product;
                    const totalSpheres = data.totalSpheres;
                    const totalPrice = data.totalPrice;

                    const itemToAdd = {
                        id: `${product.id}-${Date.now()}`,
                        name: `${product.name} (${totalSpheres} esferas)`,
                        price: totalPrice,
                        type: "esfera",
                        originalProduct: product,
                        quantity: totalSpheres,
                    };
                    if (!cartData[userJid]) {
                        cartData[userJid] = [];
                    }
                    cartData[userJid].push(itemToAdd);
                    saveJsonFile(ARQUIVO_CARRINHOS, cartData);
                    await sock.sendMessage(userJid, {
                        text: `✅ *${totalSpheres} Esferas de ${product.name}* foram adicionadas ao seu carrinho!`,
                    });
                    delete userState[userJid];
                    await sendCartView(sock, userJid);
                } else if (messageText === "2") {
                    await askForSphereQuantity(sock, userJid, data.product);
                } else if (messageText === "0") {
                    await sendSpherePurchaseList(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha uma das opções." });
                    await sendSpherePurchaseDetails(sock, userJid, data.product, data.totalSpheres, data.numTrades, data.totalPrice);
                }
            } else if (step === "awaiting_account_choice") {
                const choice = parseInt(messageText);
                if (!isNaN(choice) && choice > 0 && choice <= data.accounts.length) {
                    await sendAccountDetails(sock, userJid, data.accounts[choice - 1]);
                } else if (choice === 0) {
                    await sendBuyMenu(sock, userJid);
                } else {
                    await sock.sendMessage(userJid, { text: "❌ Opção inválida. Por favor, escolha um número da lista de contas." });
                    await sendAccountList(sock, userJid);
                }
            } else {
                console.log(`Estado não tratado: ${step}`);
                await sock.sendMessage(userJid, { text: "Desculpe, ocorreu um erro ou a sua sessão expirou. Por favor, digite */m* para voltar ao menu principal." });
                delete userState[userJid];
            }
        } catch (error) {
            console.error("!! ERRO INESPERADO NO FLUXO PRINCIPAL !!", error);
            if (userState[userJid]) delete userState[userJid];
        }
    });
}

function main() {
    const app = express();
    const port = process.env.PORT || 3000;
    app.get("/", (req, res) => {
        res.json({
            status: "online",
            timestamp: new Date().toISOString(),
            message: "Bot PowerShop está vivo!",
        });
    });
    app.listen(port, () =>
        console.log(`Servidor Keep-Alive rodando na porta ${port}.`),
    );
    // Adiciona um log periódico para manter o bot "acordado" em algumas plataformas
    setInterval(() => {
        console.log("Bot está vivo... " + new Date().toLocaleString("pt-BR"));
    }, 4 * 60 * 1000); // A cada 4 minutos

    connectToWhatsApp();
}

main();