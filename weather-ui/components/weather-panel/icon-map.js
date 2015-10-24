
var icon_map = {
	"chanceflurries": 	"icon-snowy",
	"chancerain": 		"icon-showers",
	"chancesleet": 		"icon-sleet",
	"chancesnow": 		"icon-cloud icon-snowy",
	"chancetstorms": 	"icon-thunder",
	"clear": 			"icon-sun",
	"cloudy": 			"icon-cloud",
	"flurries": 		"icon-windysnowcloud icon-sunny",
	"fog":   			"icon-mist",
	"hazy":  			"icon-mist",
	"mostlycloudy":  	"icon-cloudy",
	"mostlysunny":   	"icon-sun icon-cloudy",
	"partlycloudy":  	"icon-cloud",
	"partlysunny":   	"icon-sunny",
	"sleet": 			"icon-cloud icon-snowy",
	"rain":  			"icon-cloud icon-rainy",
	"sleet": 			"icon-sleet",
	"snow":  			"icon-cloud icon-snowy",
	"sunny": 			"icon-sun",
	"tstorms": 			"icon-thunder"
};

var default_icon = icon_map["clear"];

export default function(icon){
	return icon_map[icon] || default_icon;
}