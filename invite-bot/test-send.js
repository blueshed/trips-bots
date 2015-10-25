
require('dotenv').load();


var sendgrid  = require('sendgrid')(
						process.env.SENDGRID_USERNAME, 
						process.env.SENDGRID_PASSWORD);

sendgrid.send({
  to:       'oskar@spddo.co.uk',
  cc: 		'pete@blueshed.co.uk', 
  from:     'pete@blueshed.co.uk',
  subject:  'Hello World',
  text:     'My first email through SendGrid using node.js.'
}, function(err, json) {
  if (err) { return console.error(err); }
  console.log(json);
});