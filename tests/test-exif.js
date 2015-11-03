"use strict";

var pathExifMapper = require('path-exif-mapper').PathExifMap;

var path = "tests/IMG_3023.jpg";

try{
    console.log(path);
    pathExifMapper(path, function(path, metadata){
        var date = metadata.exif.CreateDate;
        date = date.split(" ");
        date = date[0].split(":").join("-") + ' ' + date[1];
        console.log(date);
    });
}
catch(ex){
    console.log(err, ex);
}
