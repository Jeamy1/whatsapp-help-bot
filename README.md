# WhatsApp Help Bot 🤖

Bot de WhatsApp com FAQ dinâmica controlada por terminal

## Instalação no Termux

```bash
pkg update && pkg upgrade
pkg install git nodejs
mkdir -p ~/whatsapp-bot
cd ~/whatsapp-bot
git clone https://github.com/Jeamy1/whatsapp-help-bot.git .
npm install
cp .env.example .env
npm start
```

## Usar

No terminal:

```
!addfaq Como funciona? | Você escolhe, paga e envia o comprovante.
!addfaq Qual é o preço? | R$ 99.90
!listfaq
!status
```

No WhatsApp:
- Cliente: "Como funciona?"
- Bot: "Você escolhe, paga e envia o comprovante."

## Comandos

- `!help` - Mostra ajuda
- `!addfaq pergunta | resposta` - Adiciona FAQ
- `!listfaq` - Lista FAQ
- `!editfaq pergunta | nova resposta` - Edita FAQ
- `!delfaq pergunta` - Remove FAQ
- `!clearfaq` - Limpa tudo
- `!status` - Status do bot

## Licença

MIT
