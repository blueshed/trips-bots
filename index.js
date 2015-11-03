/**
    This serves up the dist weather-ui directory
    and an admin page.

    It also runs the weather bot.
 */

var fs = require('fs');
var http = require('http');
var connect = require('connect');
var serveStatic = require('serve-static');
var multiparty = require('multiparty');


var AWS_REGION = "eu-west-1",
    BUCKET_NAME = 'trips-bot';


var WeatherBot = require('./weather-bot/main');
var S3FBFile = require('./s3_fb_file');

/**
    load environment variables if not in git hub
 */
require('dotenv').config({silent: false});

/**
    set up resources
 */
var PORT = process.env.PORT || 8080;

var userCount = 0;
var weather_bot = new WeatherBot(process.env.FB_PATH,
								 process.env.WU_API_KEY);

var app = connect();

/**
    handle admin request
 */
function handleAdmin(request, response){
    console.log('New connection');
    userCount++;

    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.write('Hello!\n');
    response.write('We have had '+userCount+' visits!\n');
    weather_bot.items().map(function(item){
        response.write(item.id + " " + JSON.stringify(item.value) + "\n");
    });
    response.end();
}


/**
    setup routes
 */
app.use('/admin', function adminHandler(request, response, next) {
  handleAdmin(request, response);
  next();
});


app.use('/upload', function(req, resp, next) {

	var form = new multiparty.Form();
	form.parse(req, function(err,fields,files){
		Promise.all(files.file.map(function(file) {
			return new S3FBFile(file.path, AWS_REGION, BUCKET_NAME, process.env.FB_PATH).init();
		})).then(function(data){
			// don't forget to delete all req.files when done
			try{
				data.map(function(item) {
					console.log(item.path, item.lat(), item.lng());
				 	fs.unlinkSync(item.path);
				});
			} catch(ex){
				console.log(ex);
			}
			resp.writeHead(200);
		    resp.end();
			next();
		}, function(err){
			console.log(err);
			resp.writeHead(500);
		    resp.end();
			next();
		});
	});
});

app.use(serveStatic('weather-ui/dist', {'index': ['index.html', 'index.htm']}));


/**
    start listening
 */
app.listen(PORT);

console.log('listening on port ' + PORT);
console.log('Server started');
