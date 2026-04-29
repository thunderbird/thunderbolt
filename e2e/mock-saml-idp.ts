import * as http from 'node:http'
import * as zlib from 'node:zlib'
import * as samlify from 'samlify'
import { IDP_CERT, IDP_PRIVATE_KEY } from './saml-test-certs'

/** Test user claims returned by the mock IdP */
const TEST_USER = {
  email: 'e2e-saml@thunderbolt.test',
  displayName: 'E2E SAML User',
  givenName: 'E2E',
  surname: 'SAML User',
}

/**
 * Create and start a mock SAML Identity Provider.
 *
 * When the browser hits GET /saml/sso?SAMLRequest=..., the server:
 * 1. Decodes the AuthnRequest to extract the ACS URL and request ID
 * 2. Generates a signed SAMLResponse using samlify
 * 3. Returns an HTML page that auto-submits the response to the ACS URL
 */
export const createMockSamlIdp = async (port: number) => {
  const issuer = `http://localhost:${port}`

  // Disable samlify's built-in schema validation — we're the IdP, not validating inbound
  samlify.setSchemaValidator({ validate: async () => 'skipped' })

  const idp = samlify.IdentityProvider({
    entityID: issuer,
    signingCert: IDP_CERT,
    privateKey: IDP_PRIVATE_KEY,
    singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: `${issuer}/saml/sso` }],
    nameIDFormat: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
    isAssertionEncrypted: false,
    wantAuthnRequestsSigned: false,
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer)

    if (url.pathname === '/saml/sso') {
      try {
        const samlRequestEncoded = url.searchParams.get('SAMLRequest')
        const relayState = url.searchParams.get('RelayState') ?? ''

        if (!samlRequestEncoded) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Missing SAMLRequest')
          return
        }

        // Decode: URL-decode -> base64-decode -> inflate
        const compressed = Buffer.from(samlRequestEncoded, 'base64')
        const xml = zlib.inflateRawSync(compressed).toString('utf-8')

        // Extract ACS URL and RequestID from the AuthnRequest
        const acsMatch = xml.match(/AssertionConsumerServiceURL="([^"]+)"/)
        const idMatch = xml.match(/ID="([^"]+)"/)
        const acsUrl = acsMatch?.[1] ?? ''
        const requestId = idMatch?.[1] ?? '_unknown'

        if (!acsUrl) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('No ACS URL in SAMLRequest')
          return
        }

        // Create a temporary SP representing the requester so samlify can generate
        // a properly addressed response
        const sp = samlify.ServiceProvider({
          entityID: 'e2e-saml-sp',
          assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: acsUrl }],
        })

        // samlify's createLoginResponse with 'post' binding returns base64-encoded XML
        const { context: samlResponseB64 } = await idp.createLoginResponse(
          sp,
          { extract: { request: { id: requestId } } },
          'post',
          TEST_USER,
          createAttributeTemplate(TEST_USER),
        )

        // Return an auto-submitting HTML form (standard SAML HTTP-POST binding)
        const html = `<!DOCTYPE html>
<html><body onload="document.forms[0].submit()">
  <form method="POST" action="${escapeHtml(acsUrl)}">
    <input type="hidden" name="SAMLResponse" value="${samlResponseB64}" />
    <input type="hidden" name="RelayState" value="${escapeHtml(relayState)}" />
    <noscript><button type="submit">Continue</button></noscript>
  </form>
</body></html>`

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(html)
      } catch (err) {
        console.error('Mock SAML IdP error:', err)
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(`Mock SAML IdP error: ${err}`)
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  })

  await new Promise<void>((resolve) => server.listen(port, 'localhost', resolve))
  console.log(`Mock SAML IdP started on port ${port}`)

  return server
}

const escapeHtml = (str: string) =>
  str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Build a custom SAML attribute statement with the test user's claims.
 */
const createAttributeTemplate = (user: typeof TEST_USER) =>
  `<saml:AttributeStatement>
    <saml:Attribute Name="email"><saml:AttributeValue xsi:type="xs:string">${user.email}</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="displayName"><saml:AttributeValue xsi:type="xs:string">${user.displayName}</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="givenName"><saml:AttributeValue xsi:type="xs:string">${user.givenName}</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="surname"><saml:AttributeValue xsi:type="xs:string">${user.surname}</saml:AttributeValue></saml:Attribute>
  </saml:AttributeStatement>`
