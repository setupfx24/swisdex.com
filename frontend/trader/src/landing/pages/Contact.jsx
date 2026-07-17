import { useState, useRef, useEffect } from 'react'
import { Mail, MapPin, Send, MessageCircle, X } from 'lucide-react'
import Button from '../components/Button'
import Card from '../components/Card'
import ScrollReveal, { ScrollRevealGroup, ScrollRevealItem } from '../components/animations/ScrollReveal'

/** Official WhatsApp glyph — lucide-react doesn't ship brand logos, so we
 *  inline the SVG. Inherits size + colour from className (currentColor). */
function WhatsAppIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.945C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 018.413 3.488 11.82 11.82 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.82 9.82 0 001.671 5.475l-.999 3.648 3.817-1.002zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
    </svg>
  )
}

const Contact = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: '',
    message: ''
  })

  const [isChatOpen, setIsChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState([
    { from: 'agent', text: 'Hi there! 👋 I\'m SwisBot, your SwisDex assistant. How can I help you today?', time: 'now' }
  ])
  const chatEndRef = useRef(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isChatOpen])

  const getAutoReply = (text) => {
    const t = text.toLowerCase()
    if (t.includes('account') || t.includes('open')) return 'You can open a free account in under 2 minutes from our Accounts page. Would you like me to send you the link?'
    if (t.includes('deposit') || t.includes('fund')) return 'We support card, bank wire, and crypto deposits with zero fees. Minimum deposit is $100 for Standard and $5,000 for Pro.'
    if (t.includes('spread') || t.includes('fee')) return 'Our spreads start from 0.0 pips on Pro accounts. Standard accounts have no commission with spreads from 1.1 pips.'
    if (t.includes('platform')) return 'We offer our Web Platform, Copy Trading, Prop Trading, and IB Management tools. Visit the Platforms page to learn more.'
    if (t.includes('hi') || t.includes('hello') || t.includes('hey')) return 'Hello! 👋 How can I assist you with your trading today?'
    if (t.includes('thank')) return 'You\'re welcome! Is there anything else I can help you with?'
    return 'Thanks for your message! One of our support specialists will get back to you shortly. In the meantime, feel free to ask about accounts, platforms, spreads, or deposits.'
  }

  const handleSendChat = (e) => {
    e.preventDefault()
    if (!chatInput.trim()) return
    const userMsg = { from: 'user', text: chatInput, time: 'now' }
    setMessages((prev) => [...prev, userMsg])
    const replyText = getAutoReply(chatInput)
    setChatInput('')
    setTimeout(() => {
      setMessages((prev) => [...prev, { from: 'agent', text: replyText, time: 'now' }])
    }, 800)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    // Compose an email to support@swisdex.com using the visitor's default
    // mail client. This has zero backend dependency and works today —
    // caveat: the visitor must have a mail client configured. For a
    // proper server-side send, wire the same fields into a Web3Forms /
    // Formspree endpoint or a small FastAPI /contact route (see
    // README.contact.md for the how-to).
    const to = 'support@swisdex.com'
    const subject = `[SwisDex Contact] ${formData.subject || 'General enquiry'} — ${formData.name || 'Unknown'}`
    const body =
      `Name: ${formData.name}\n` +
      `Email: ${formData.email}\n` +
      `Subject: ${formData.subject}\n\n` +
      `${formData.message}\n`
    window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    setFormData({ name: '', email: '', subject: '', message: '' })
  }

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value })
  }

  const contactInfo = [
    {
      icon: Mail,
      title: 'Email Us',
      content: 'info@swisdex.com',
      link: 'mailto:info@swisdex.com'
    },
    {
      icon: WhatsAppIcon,
      title: 'WhatsApp',
      content: '+44 7737119978',
      link: 'https://wa.me/447737119978'
    },
    {
      icon: MapPin,
      title: '📍 Visit Us — United Kingdom',
      content: 'Office 23US, 18 Young St, UNIT LGE 1/1, Edinburgh EH2 4JB, Scotland, United Kingdom 🇬🇧',
      link: 'https://www.google.com/maps/search/?api=1&query=18+Young+Street+Edinburgh+EH2+4JB',
    },
  ]

  return (
    <div className="min-h-screen pt-20">
      <section className="section-padding hero-banner">
        <div className="container-custom text-center">
          <ScrollReveal variant="fadeUp">
            <h1 className="text-5xl md:text-6xl font-bold text-white mb-6">Get in Touch</h1>
            <p className="text-xl text-text-secondary max-w-3xl mx-auto">
              Have a question? Our team is here to help. Reach out to us anytime.
            </p>
          </ScrollReveal>
        </div>
      </section>

      <section className="section-padding bg-primary-secondary">
        <div className="container-custom">
          <ScrollRevealGroup className="grid md:grid-cols-3 gap-8 mb-12">
            {contactInfo.map((info, index) => (
              <ScrollRevealItem key={index}>
                <Card className="text-center p-8">
                  <info.icon className="w-12 h-12 text-primary-accent mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-white mb-2">{info.title}</h3>
                  <a
                    href={info.link}
                    target={info.link.startsWith('http') ? '_blank' : undefined}
                    rel={info.link.startsWith('http') ? 'noopener noreferrer' : undefined}
                    className="text-text-secondary hover:text-primary-accent transition-colors"
                  >
                    {info.content}
                  </a>
                </Card>
              </ScrollRevealItem>
            ))}
          </ScrollRevealGroup>

          {/* UK office pin — Google Maps embed for Edinburgh HQ */}
          <ScrollReveal variant="fadeUp">
            <div className="mb-16 rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
              <div className="bg-white/[0.03] px-6 py-4 flex items-center gap-3">
                <MapPin className="w-5 h-5 text-primary-accent" />
                <div>
                  <div className="text-white font-semibold text-sm">SwisDex UK Office</div>
                  <div className="text-text-secondary text-xs">
                    18 Young St, Edinburgh EH2 4JB, Scotland
                  </div>
                </div>
                <a
                  href="https://www.google.com/maps/search/?api=1&query=18+Young+Street+Edinburgh+EH2+4JB"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto text-xs text-primary-accent hover:underline"
                >
                  Open in Google Maps →
                </a>
              </div>
              <iframe
                title="SwisDex UK office location"
                src="https://www.google.com/maps?q=18+Young+Street+Edinburgh+EH2+4JB&output=embed"
                width="100%"
                height="360"
                style={{ border: 0 }}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
              />
            </div>
          </ScrollReveal>

          <div className="grid lg:grid-cols-2 gap-12">
            <ScrollReveal variant="fadeLeft">
              <div>
                <h2 className="text-3xl font-bold text-white mb-6">Send Us a Message</h2>
                <form onSubmit={handleSubmit} className="space-y-6">
                  <div>
                    <label className="block text-text-secondary mb-2">Name</label>
                    <input
                      type="text"
                      name="name"
                      value={formData.name}
                      onChange={handleChange}
                      required
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-primary-accent transition-colors"
                      placeholder="Your name"
                    />
                  </div>
                  <div>
                    <label className="block text-text-secondary mb-2">Email</label>
                    <input
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleChange}
                      required
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-primary-accent transition-colors"
                      placeholder="your@email.com"
                    />
                  </div>
                  <div>
                    <label className="block text-text-secondary mb-2">Subject</label>
                    <select
                      name="subject"
                      value={formData.subject}
                      onChange={handleChange}
                      required
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-primary-accent transition-colors"
                    >
                      <option value="">Select a subject</option>
                      <option value="general">General Inquiry</option>
                      <option value="account">Account Support</option>
                      <option value="technical">Technical Issue</option>
                      <option value="partnership">Partnership</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-text-secondary mb-2">Message</label>
                    <textarea
                      name="message"
                      value={formData.message}
                      onChange={handleChange}
                      required
                      rows="6"
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-primary-accent transition-colors resize-none"
                      placeholder="How can we help you?"
                    ></textarea>
                  </div>
                  <Button type="submit" variant="primary" noPopup className="w-full flex items-center justify-center gap-2">
                    <Send className="w-5 h-5" />
                    Send Message
                  </Button>
                </form>
              </div>
            </ScrollReveal>

            <ScrollReveal variant="fadeRight" delay={0.2}>
              <div>
                <h2 className="text-3xl font-bold text-white mb-6">Our Office</h2>
                <Card className="p-8 mb-6">
                  <h3 className="text-xl font-semibold text-white mb-4">SwisDex Ltd</h3>
                  <p className="text-text-secondary mb-4">
                    Office 23US, 18 Young St<br />
                    UNIT LGE 1/1<br />
                    Edinburgh EH2 4JB<br />
                    Scotland
                  </p>
                  <div className="space-y-2">
                    <p className="text-text-secondary">
                      <span className="text-white font-semibold">WhatsApp:</span> +44 7737119978
                    </p>
                    <p className="text-text-secondary">
                      <span className="text-white font-semibold">Email:</span> info@swisdex.com
                    </p>
                  </div>
                </Card>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      <section className="section-padding bg-primary-bg">
        <div className="container-custom text-center">
          <ScrollReveal variant="fadeUp">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-6">
              Need Immediate Assistance?
            </h2>
            <p className="text-xl text-text-secondary mb-8 max-w-2xl mx-auto">
              Our 24/7 support team is one tap away — WhatsApp, in-app chat, or email.
            </p>

            {/* WhatsApp number details — surfaced alongside the live-chat CTA
                so visitors don't have to dig through the cards above. */}
            <div className="mb-6 inline-flex flex-col items-center gap-2">
              <a
                href="https://wa.me/447737119978"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-3 px-6 py-3 rounded-2xl bg-[#25D366] text-white font-semibold text-base sm:text-lg shadow-lg hover:opacity-90 transition"
                aria-label="WhatsApp +44 7737 119978"
              >
                <WhatsAppIcon className="w-6 h-6" />
                WhatsApp: +44 7737 119978
              </a>
              <span className="text-xs text-text-secondary">
                Reply usually within minutes · Available 24/7
              </span>
            </div>

            <div className="flex flex-wrap justify-center gap-3">
              <Button variant="primary" onClick={() => setIsChatOpen(true)}>
                <MessageCircle className="w-5 h-5" />
                Start Live Chat
              </Button>
              <a
                href="mailto:info@swisdex.com"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-white/20 text-white font-semibold hover:bg-white/5 transition"
              >
                <Mail className="w-5 h-5" />
                Email us
              </a>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {isChatOpen && (
        <div className="fixed bottom-6 right-6 z-[100] w-[calc(100vw-3rem)] sm:w-96 animate-fade-in">
          <div className="glass-card overflow-hidden flex flex-col h-[500px] shadow-2xl">
            <div className="bg-gradient-primary p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center font-bold text-white">
                    S
                  </div>
                  <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 rounded-full border-2 border-white"></div>
                </div>
                <div>
                  <div className="font-semibold text-white">SwisBot — Support</div>
                  <div className="text-xs text-white/80">Online • Typically replies instantly</div>
                </div>
              </div>
              <button
                onClick={() => setIsChatOpen(false)}
                className="text-white/80 hover:text-white transition-colors"
                aria-label="Close chat"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-primary-bg/50">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] px-4 py-2 rounded-2xl text-sm ${
                      msg.from === 'user'
                        ? 'bg-primary-accent text-white rounded-br-sm'
                        : 'bg-white/10 text-white rounded-bl-sm'
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <form
              onSubmit={handleSendChat}
              className="p-3 border-t border-white/10 bg-primary-secondary flex items-center gap-2"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Type your message..."
                className="flex-1 bg-white/5 border border-white/10 rounded-full px-4 py-2 text-white placeholder:text-text-secondary focus:outline-none focus:border-primary-accent transition-colors text-sm"
              />
              <button
                type="submit"
                className="w-10 h-10 bg-primary-accent hover:bg-primary-accent/80 rounded-full flex items-center justify-center transition-colors flex-shrink-0"
                aria-label="Send"
              >
                <Send className="w-4 h-4 text-white" />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default Contact
